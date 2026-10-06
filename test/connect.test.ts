/**
 * Connected apps.
 *
 * The sharp edge these cover: an action against an account nobody connected
 * fails after the user pressed the button, with an error written for an API
 * client. Everything here is about finding that out first, and saying it in a
 * sentence the person reading can act on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Workser, WorkserError } from '../src/index.js';
import {
  isActive,
  prettyToolkit,
  toolkitOf,
  toolkitSlug,
} from '../src/resources/connect.js';

const BASE = {
  projectId: 'p_1',
  apiKey: 'wsr_run_abcdef1234567890',
  baseUrl: 'https://api.workser.ai',
};

function stub(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let i = 0;
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    });
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const client = (responses: unknown[]) => {
  const s = stub(responses);
  return { workser: new Workser({ ...BASE, fetch: s.fetchImpl }), calls: s.calls };
};

test('isActive accepts every spelling of connected, and no other state', () => {
  for (const status of ['ACTIVE', 'active', 'connected', 'ENABLED']) {
    assert.equal(isActive({ id: 'c', status }), true, status);
  }
  // INITIATED is a half-finished OAuth. Treating it as connected is how a
  // feature looks enabled and fails on first use.
  for (const status of ['INITIATED', 'FAILED', 'expired', '', undefined]) {
    assert.equal(isActive({ id: 'c', status } as never), false, String(status));
  }
});

test('toolkitSlug reads the several shapes the API uses', () => {
  assert.equal(toolkitSlug({ id: 'c', toolkit: 'GMAIL' }), 'gmail');
  assert.equal(toolkitSlug({ id: 'c', toolkit_slug: 'slack' } as never), 'slack');
  assert.equal(toolkitSlug({ id: 'c', appName: 'Notion' } as never), 'notion');
  assert.equal(toolkitSlug({ id: 'c' }), null);
});

test('toolkitOf derives the account from the action, and refuses to guess', () => {
  assert.equal(toolkitOf('GMAIL_SEND_EMAIL'), 'gmail');
  assert.equal(toolkitOf('GOOGLESHEETS_APPEND_ROW'), 'googlesheets');
  // No underscore: a wrong toolkit here would check the wrong account and
  // refuse a call that would have worked.
  assert.equal(toolkitOf('SOMETHING'), null);
  assert.equal(toolkitOf(''), null);
});

test('prettyToolkit writes a name a person reads', () => {
  assert.equal(prettyToolkit('googlesheets'), 'Google Sheets');
  assert.equal(prettyToolkit('GMAIL'), 'Gmail');
  // Unknown ones are title-cased rather than left lower — "connect a acme
  // account" reads like a typo in the sentence this lands in.
  assert.equal(prettyToolkit('acme'), 'Acme');
  assert.equal(prettyToolkit(''), 'that');
});

test('isConnected asks only about that toolkit, and ignores half-finished ones', async () => {
  const { workser, calls } = client([
    [{ id: 'c1', toolkit: 'gmail', status: 'INITIATED' }],
  ]);
  assert.equal(await workser.connect.isConnected('gmail'), false);
  assert.match(calls[0]!.url, /\/composio\/connections\?toolkit=gmail$/);
});

test('connected() lists the accounts that can actually be used, deduped', async () => {
  const { workser } = client([
    [
      { id: 'c1', toolkit: 'GMAIL', status: 'ACTIVE' },
      { id: 'c2', toolkit: 'gmail', status: 'active' },
      { id: 'c3', toolkit: 'slack', status: 'INITIATED' },
      { id: 'c4', toolkit: 'googlesheets', status: 'connected' },
    ],
  ]);
  assert.deepEqual(await workser.connect.connected(), ['gmail', 'googlesheets']);
});

test('requireConnection names the account and who has to connect it', async () => {
  const { workser } = client([[]]);
  await assert.rejects(
    () => workser.connect.requireConnection('googlesheets'),
    (err: unknown) => {
      assert.ok(err instanceof WorkserError);
      assert.equal(err.code, 'forbidden');
      assert.match(err.message, /Google Sheets/);
      // The person reading the error page cannot fix this themselves.
      assert.match(err.message, /project owner/);
      assert.equal((err.details as { toolkit: string }).toolkit, 'googlesheets');
      return true;
    },
  );
});

test('safeRun checks the account before touching it', async () => {
  const { workser, calls } = client([[]]);
  await assert.rejects(
    () => workser.connect.safeRun('GMAIL_SEND_EMAIL', { to: 'a@b.c' }),
    /Gmail/,
  );
  // One call, and it was the CHECK. The send never left.
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /connections\?toolkit=gmail$/);
});

test('safeRun runs the action once the account is there', async () => {
  const { workser, calls } = client([
    [{ id: 'c1', toolkit: 'gmail', status: 'ACTIVE' }],
    { ok: true },
  ]);
  await workser.connect.safeRun('GMAIL_SEND_EMAIL', { to: 'a@b.c' }, {
    idempotencyKey: 'k1',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.url, /\/composio\/tools\/GMAIL_SEND_EMAIL\/execute$/);
  assert.equal(calls[1]!.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1]!.body!), { arguments: { to: 'a@b.c' } });
});

test('safeRun with an unparseable slug still runs, rather than refusing', async () => {
  // The toolkit could not be derived, so there is nothing to check. Refusing
  // here would break every action whose slug does not follow the convention.
  const { workser, calls } = client([{ ok: true }]);
  await workser.connect.safeRun('CUSTOMACTION', {});
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/tools\/CUSTOMACTION\/execute$/);
});

/* ───────────────────── an app whose users bring their own accounts ────────── */

test('a reference user is asked about, connected and acted in as that user', () => {
  // A multi-tenant app: each of YOUR customers links THEIR own Gmail. The id
  // is what decides whose mailbox comes out the other end, and it was
  // previously unreachable without dropping to `workser.request`.
  const { workser, calls } = client([[]]);
  return workser.connect
    .connections({ toolkit: 'gmail', referenceUserId: 'user_42' })
    .then(() => {
      assert.match(calls[0]!.url, /reference_user_id=user_42/);
      assert.match(calls[0]!.url, /toolkit=gmail/);
    });
});

test('run sends the reference user, and omits it entirely when there is none', async () => {
  const scoped = client([{ ok: true }]);
  await scoped.workser.connect.run('GMAIL_SEND_EMAIL', { to: 'a@b.com' }, {
    referenceUserId: 'user_42',
  });
  assert.deepEqual(JSON.parse(scoped.calls[0]!.body!), {
    arguments: { to: 'a@b.com' },
    reference_user_id: 'user_42',
  });

  // The project-scoped call must be byte-identical to what it always sent —
  // a `reference_user_id: null` in the body would be a new field on every
  // existing caller's request.
  const project = client([{ ok: true }]);
  await project.workser.connect.run('GMAIL_SEND_EMAIL', { to: 'a@b.com' });
  assert.deepEqual(JSON.parse(project.calls[0]!.body!), {
    arguments: { to: 'a@b.com' },
  });
});

test('safeRun checks the SAME account it is about to act in', async () => {
  // The reason the scope is threaded through the guard and not just the run:
  // checking the project's Gmail and then sending as a customer is a guard
  // that passes on somebody else's connection.
  const { workser, calls } = client([[{ id: 'c1', toolkit: 'gmail', status: 'ACTIVE' }]]);
  await workser.connect.safeRun('GMAIL_SEND_EMAIL', {}, { referenceUserId: 'user_42' });
  assert.match(calls[0]!.url, /connections\?/);
  assert.match(calls[0]!.url, /reference_user_id=user_42/);
  assert.deepEqual(JSON.parse(calls[1]!.body!), {
    arguments: {},
    reference_user_id: 'user_42',
  });
});

test('the missing-connection message names whoever can actually fix it', async () => {
  // Two scopes, two different next steps. Telling an end user to contact the
  // project owner sends them somewhere that cannot help them.
  const asUser = client([[]]);
  await assert.rejects(
    asUser.workser.connect.requireConnection('gmail', { referenceUserId: 'user_42' }),
    (err: WorkserError) => {
      assert.match(err.message, /Link yours/);
      assert.equal((err.details as Record<string, unknown>).referenceUserId, 'user_42');
      return true;
    },
  );

  const asProject = client([[]]);
  await assert.rejects(
    asProject.workser.connect.requireConnection('gmail'),
    (err: WorkserError) => {
      assert.match(err.message, /project owner can connect it/);
      return true;
    },
  );
});
