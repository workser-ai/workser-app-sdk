/**
 * Agent Cloud streaming.
 *
 * These pin the behaviours that make a two-hour agent run watchable, and each
 * one names the failure it prevents — a stream is the hardest thing in this
 * SDK to debug from a bug report, because by the time somebody notices, the
 * events are gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Workser, WorkserError } from '../src/index.js';
import { parseSse } from '../src/streaming.js';

const BASE = {
  projectId: 'p_1',
  apiKey: 'wsr_run_abcdef1234567890',
  baseUrl: 'https://api.workser.ai',
  maxRetries: 0,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A `text/event-stream` response built from literal chunks of wire bytes. */
function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function frame(seq: number, type: string, data: Record<string, unknown> = {}) {
  return (
    `id: ${seq}\n` +
    `event: ${type}\n` +
    `data: ${JSON.stringify({ event_id: `e_${seq}`, type, seq, data })}\n\n`
  );
}

/** Replays a queue of responses and records every request. */
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
  return { fetchImpl, calls };
}

/* ------------------------------------------------------------------ parsing */

test('reassembles a frame split across chunk boundaries', async () => {
  // The single most common streaming bug: a naive parser treats each network
  // chunk as a message and drops or corrupts anything straddling the split.
  const whole = frame(1, 'run.started');
  const cut = Math.floor(whole.length / 2);
  const events: string[] = [];
  const res = sse([whole.slice(0, cut), whole.slice(cut)]);
  for await (const e of parseSse(res.body!)) events.push(e.event);
  assert.deepEqual(events, ['run.started']);
});

test('joins a multi-line data field with newlines rather than losing lines', async () => {
  const res = sse(['event: log\ndata: first\ndata: second\n\n']);
  const out: string[] = [];
  for await (const e of parseSse(res.body!)) out.push(e.data);
  assert.deepEqual(out, ['first\nsecond']);
});

test('yields a final frame that arrived without its trailing blank line', async () => {
  // The terminal frame is the one that matters most; a server closing the
  // socket right after it must not cost the caller the run's result.
  const res = sse(['event: run.completed\ndata: {"seq":9,"type":"run.completed"}\n']);
  const out: string[] = [];
  for await (const e of parseSse(res.body!)) out.push(e.event);
  assert.deepEqual(out, ['run.completed']);
});

test('ignores comment keep-alive lines some proxies inject', async () => {
  const res = sse([': keep-alive\n\n', frame(1, 'run.started')]);
  const out: string[] = [];
  for await (const e of parseSse(res.body!)) out.push(e.event);
  assert.deepEqual(out, ['run.started']);
});

/* ------------------------------------------------------------------ streaming */

test('streams a run to its terminal event and stops there', async () => {
  const s = stub([
    sse([frame(1, 'run.started'), frame(2, 'step.completed'), frame(3, 'run.completed')]),
  ]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  const seen: string[] = [];
  for await (const e of client.agents.stream('r_1')) seen.push(e.type);
  assert.deepEqual(seen, ['run.started', 'step.completed', 'run.completed']);
  assert.equal(s.calls.length, 1, 'a completed stream must not reconnect');
});

test('drops heartbeats — they reset the idle clock, they are not run events', async () => {
  const s = stub([
    sse([
      frame(1, 'run.started'),
      'event: heartbeat\ndata: {"ts":1}\n\n',
      frame(2, 'run.completed'),
    ]),
  ]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  const seen: string[] = [];
  for await (const e of client.agents.stream('r_1')) seen.push(e.type);
  assert.deepEqual(seen, ['run.started', 'run.completed']);
});

test('resumes at the last handled sequence, with no gap and no duplicate', async () => {
  // The reason this SDK method exists at all. A dropped connection mid-run
  // must be invisible to the caller: replaying from 0 would double-deliver
  // events 1-2, and resuming from 0 offset would lose them.
  let call = 0;
  const s = stub([
    () => {
      call++;
      if (call === 1) {
        // Closes cleanly after 2, without a terminal event.
        return sse([frame(1, 'run.started'), frame(2, 'step.completed')]);
      }
      return sse([frame(3, 'run.completed')]);
    },
  ]);
  // The clean-close path re-reads the run to decide whether to reconnect.
  const client = new Workser({
    ...BASE,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/events')) return s.fetchImpl(url as URL, init);
      return json({ id: 'r_1', status: 'RUNNING' });
    }) as typeof fetch,
  });

  const seen: number[] = [];
  for await (const e of client.agents.stream('r_1')) seen.push(e.seq);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.match(s.calls[1]!.url, /after_seq=2/, 'must resume from the last handled seq');
});

test('stops reconnecting once the run row says the run is over', async () => {
  // A stream that closes cleanly on a finished run must END, not reconnect
  // forever against a run that will never emit again.
  const s = stub([sse([frame(1, 'run.started')])]);
  const client = new Workser({
    ...BASE,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).includes('/events')) return s.fetchImpl(url as URL, init);
      return json({ id: 'r_1', status: 'COMPLETED' });
    }) as typeof fetch,
  });
  const seen: number[] = [];
  for await (const e of client.agents.stream('r_1')) seen.push(e.seq);
  assert.deepEqual(seen, [1]);
  assert.equal(s.calls.length, 1);
});

test('gives up with an error rather than silently ending a live run', async () => {
  // Silence that looks like completion is the worst possible failure here:
  // the caller would report success on work that never finished.
  const s = stub([sse([])]);
  const client = new Workser({
    ...BASE,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).includes('/events')) return s.fetchImpl(url as URL, init);
      return json({ id: 'r_1', status: 'RUNNING' });
    }) as typeof fetch,
  });
  await assert.rejects(
    async () => {
      for await (const _ of client.agents.stream('r_1', { maxReconnects: 1 })) void _;
    },
    (err: unknown) => err instanceof WorkserError && /without the run finishing/.test((err as Error).message),
  );
});

test('surfaces a 403 immediately instead of retrying a permission failure', async () => {
  const s = stub([new Response('forbidden', { status: 403 })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  await assert.rejects(
    async () => {
      for await (const _ of client.agents.stream('r_1')) void _;
    },
    (err: unknown) => err instanceof WorkserError && err.status === 403,
  );
  assert.equal(s.calls.length, 1);
});

test('sends the same credential on a stream as on a request', async () => {
  const s = stub([sse([frame(1, 'run.completed')])]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  for await (const _ of client.agents.stream('r_1')) void _;
  assert.equal(s.calls[0]!.headers.authorization, `Bearer ${BASE.apiKey}`);
  assert.equal(s.calls[0]!.headers.accept, 'text/event-stream');
});

/* ------------------------------------------------------------------ invoking */

test('gives two identical calls different idempotency keys', async () => {
  // A content-derived key would collapse "check inventory" asked twice into
  // one run and hand back a stale answer to the second caller.
  // A factory, not a shared Response: a body can only be read once.
  const s = stub([() => json({ id: 'r_1', agent_id: 'a_1', session_id: 's_1', status: 'QUEUED' })]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  await client.agents.run('a_1', { message: 'hi' });
  await client.agents.run('a_1', { message: 'hi' });
  const [one, two] = s.calls.map((c) => c.headers['idempotency-key']);
  assert.ok(one && two, 'every run must carry an idempotency key');
  assert.notEqual(one, two);
});

test('scopes a list to this project without the caller passing it', async () => {
  const s = stub([json([{ id: 'a_1', name: 'Order desk' }])]);
  const client = new Workser({ ...BASE, fetch: s.fetchImpl });
  await client.agents.list();
  assert.match(s.calls[0]!.url, /project_id=p_1/);
});
