/**
 * Transport behaviour.
 *
 * Retries are the dangerous part of any SDK: retrying the wrong thing turns
 * one order into two, and not retrying the right thing makes an agent look
 * unreliable on a transient blip. These pin both directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Workser, WorkserError } from '../src/index.js';

const BASE = {
  projectId: 'p_1',
  apiKey: 'wsr_run_abcdef1234567890',
  cloudApiKey: 'wks_cloudkey123456',
  baseUrl: 'https://api.workser.ai',
};

/** A fetch stub that replays a queue of responses and records every call. */
function stub(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let i = 0;
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | undefined,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { fetchImpl, calls, count: () => i };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('unwraps the { data } envelope so callers never have to know', async () => {
  const s = stub([json({ data: [{ id: 'o_1' }] })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  const orders = await client.business.orders.list();
  assert.deepEqual(orders, [{ id: 'o_1' }]);
});

test('leaves an unenveloped response untouched', async () => {
  const s = stub([json([{ id: 'o_1' }])]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  assert.deepEqual(await client.business.orders.list(), [{ id: 'o_1' }]);
});

test('does not mistake a resource that happens to have a `data` field', async () => {
  // A record with `data` AND other fields is the resource, not an envelope.
  const s = stub([json({ data: { rows: 1 }, id: 'x_1', name: 'report' })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  const out = await client.business.orders.get('x_1');
  assert.deepEqual(out, { data: { rows: 1 }, id: 'x_1', name: 'report' });
});

test('retries a 500 and succeeds', async () => {
  const s = stub([json({ message: 'nope' }, 500), json({ data: [{ id: 'o_1' }] })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl, maxRetries: 2 });
  assert.deepEqual(await client.business.orders.list(), [{ id: 'o_1' }]);
  assert.equal(s.count(), 2);
});

test('never retries a 4xx the caller has to fix', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const s = stub([json({ message: 'bad' }, status)]);
    const client = new Workser({ ...BASE, fetch: s.fetchImpl, maxRetries: 3 });
    await assert.rejects(() => client.business.orders.list());
    assert.equal(s.count(), 1, `status ${status} must not be retried`);
  }
});

test('retries 429 and honours Retry-After', async () => {
  const s = stub([
    json({ message: 'slow down' }, 429, { 'retry-after': '0' }),
    json({ data: [] }),
  ]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl, maxRetries: 2 });
  await client.business.orders.list();
  assert.equal(s.count(), 2);
});

test('gives up after maxRetries and reports the last failure', async () => {
  const s = stub([json({ message: 'down' }, 503)]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl, maxRetries: 2 });
  await assert.rejects(
    () => client.business.orders.list(),
    (err: unknown) => {
      if (!(err instanceof WorkserError)) return false;
      assert.equal(err.code, 'server_error');
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(s.count(), 3, 'initial attempt + 2 retries');
});

test('surfaces a network failure as `network`, having retried it', async () => {
  const s = stub([
    () => {
      throw new TypeError('fetch failed');
    },
  ]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl, maxRetries: 1 });
  await assert.rejects(
    () => client.business.orders.list(),
    (err: unknown) => err instanceof WorkserError && err.code === 'network',
  );
  assert.equal(s.count(), 2);
});

test('an idempotency key rides every retry unchanged', async () => {
  // The whole point: a retry after a timeout must be recognised as the SAME
  // create, or a customer gets charged twice.
  const s = stub([json({ message: 'oops' }, 500), json({ id: 'o_9' })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl, maxRetries: 2 });
  await client.business.orders.create({ total: 100 }, { idempotencyKey: 'order-42' });

  assert.equal(s.count(), 2);
  const keys = s.calls.map((c) => c.headers['idempotency-key']);
  assert.deepEqual(keys, ['order-42', 'order-42']);
});

test('routes infrastructure calls to the cloud key, business calls to the bearer', async () => {
  const s = stub([json({ files: [] }), json({ data: [] })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });

  await client.storage.list();
  assert.equal(s.calls[0]?.headers['x-api-key'], 'wks_cloudkey123456');
  assert.equal(s.calls[0]?.headers.authorization, undefined);

  await client.business.orders.list();
  assert.equal(s.calls[1]?.headers.authorization, 'Bearer wsr_run_abcdef1234567890');
  assert.equal(s.calls[1]?.headers['x-api-key'], undefined);
});

test('sends SQL parameters separately so they are bound, never interpolated', async () => {
  const s = stub([json({ data: [] })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  await client.db.query('select * from orders where email = $1', ["'; drop table orders;--"]);

  const body = JSON.parse(s.calls[0]?.body ?? '{}');
  assert.equal(body.query, 'select * from orders where email = $1');
  assert.deepEqual(body.params, ["'; drop table orders;--"]);
});

test('path segments are encoded, so an id cannot escape its position', async () => {
  const s = stub([json({})]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  await client.business.orders.get('../../admin');
  assert.match(s.calls[0]?.url ?? '', /orders\/\.\.%2F\.\.%2Fadmin/);
});

test('workflow calls fail clearly when the project has no workflow service', async () => {
  const s = stub([json({})]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  await assert.rejects(
    () => client.workflows.list(),
    (err: unknown) =>
      err instanceof WorkserError &&
      err.code === 'config' &&
      /WORKFLOW_BASE_URL/.test(err.message),
  );
});

test('workflow calls use the workflow service base and its own key', async () => {
  const s = stub([json({ data: [{ id: 'wf_1' }] })]);
  const client = new Workser({
    ...BASE,
    fetch: s.fetchImpl,
    workflowBaseUrl: 'https://workflow.workser.ai',
    workflowApiKey: 'wsr_workflow_key_123',
  });
  await client.workflows.list();
  assert.match(s.calls[0]?.url ?? '', /^https:\/\/workflow\.workser\.ai\/workflows/);
  assert.equal(s.calls[0]?.headers.authorization, 'Bearer wsr_workflow_key_123');
});

test('a 204 resolves to undefined rather than throwing on empty JSON', async () => {
  const s = stub([new Response(null, { status: 204 })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  assert.equal(await client.business.orders.remove('o_1'), undefined);
});
