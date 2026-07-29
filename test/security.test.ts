/**
 * The SDK's security guarantees.
 *
 * These are the properties the SDK claims in its README, so they are tested
 * rather than asserted. Each one exists because the failure it prevents is
 * silent: a leaked key does not throw, it just quietly works for whoever
 * found it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Workser, BrowserSecretError, WorkserError } from '../src/index.js';
import { redact, redactValue } from '../src/redact.js';

const BASE = { projectId: 'p_1', apiKey: 'wsr_run_abcdef1234567890', baseUrl: 'https://api.workser.ai' };

test('refuses to hold a secret key in a browser', () => {
  const g = globalThis as Record<string, unknown>;
  const original = g.window;
  g.window = { document: {} };
  try {
    assert.throws(() => new Workser(BASE), BrowserSecretError);
    // …unless the caller has explicitly reasoned about it.
    assert.doesNotThrow(() => new Workser({ ...BASE, allowBrowser: true }));
  } finally {
    if (original === undefined) delete g.window;
    else g.window = original;
  }
});

test('a partial window (edge runtime, jsdom) is not treated as a browser', () => {
  const g = globalThis as Record<string, unknown>;
  const original = g.window;
  g.window = {}; // no document
  try {
    assert.doesNotThrow(() => new Workser(BASE));
  } finally {
    if (original === undefined) delete g.window;
    else g.window = original;
  }
});

test('refuses to send a key over plaintext to a remote host', () => {
  assert.throws(
    () => new Workser({ ...BASE, baseUrl: 'http://api.example.com' }),
    (err: unknown) => err instanceof WorkserError && err.code === 'config',
  );
  // Loopback is exempt so local development works.
  assert.doesNotThrow(() => new Workser({ ...BASE, baseUrl: 'http://localhost:8000' }));
  assert.doesNotThrow(() => new Workser({ ...BASE, baseUrl: 'http://127.0.0.1:8000' }));
});

test('the key never appears in the request URL or a thrown error', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const client = new Workser({
    ...BASE,
    maxRetries: 0,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      return new Response(JSON.stringify({ message: 'boom wsr_run_abcdef1234567890' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.business.orders.list(),
    (err: unknown) => {
      if (!(err instanceof WorkserError)) return false;
      // The server echoed the key back. It must not survive into the message.
      assert.ok(!err.message.includes('wsr_run_abcdef1234567890'), 'key leaked into message');
      assert.match(err.message, /redacted/);
      // The error records where it happened, never how it authenticated.
      assert.equal(err.request?.path, '/v1/projects/p_1/orders');
      assert.ok(!JSON.stringify(err.request).includes('wsr_run_'));
      return true;
    },
  );

  assert.ok(!seenUrl.includes('wsr_run_'), 'key must never enter the URL');
  assert.equal(seenAuth, 'Bearer wsr_run_abcdef1234567890', 'key belongs only in the header');
});

test('redaction masks known credential shapes but keeps them identifiable', () => {
  const out = redact('key=wsr_run_abcdef1234567890 and sk-abcdefghijklmnop');
  assert.ok(!out.includes('abcdef1234567890'));
  assert.match(out, /wsr_run_/, 'the family stays visible for debugging');
  assert.match(out, /redacted/);
});

test('redaction masks database passwords without destroying the URI shape', () => {
  const out = redact('postgres://user:sup3rs3cret@db.neon.tech/main');
  assert.ok(!out.includes('sup3rs3cret'));
  assert.match(out, /postgres:\/\/user:\*\*\*@/);
});

test('secret-named fields are dropped entirely, not merely masked', () => {
  const out = redactValue({
    ok: true,
    password: 'hunter2',
    nested: { api_key: 'wsr_live', DATABASE_URL: 'postgres://a:b@c/d' },
  }) as Record<string, any>;

  assert.equal(out.ok, true);
  // Masking would still reveal the length; a password field reveals nothing.
  assert.equal(out.password, '[redacted]');
  assert.equal(out.nested.api_key, '[redacted]');
  assert.equal(out.nested.DATABASE_URL, '[redacted]');
});

test('a missing project id names the variable instead of failing obscurely', () => {
  assert.throws(
    () => new Workser({ apiKey: 'wsr_run_x123456' }),
    (err: unknown) =>
      err instanceof WorkserError &&
      err.code === 'config' &&
      /WORKSER_PROJECT_ID/.test(err.message),
  );
});

test('refuses a key in React Native, which has no window.document', () => {
  // A mobile binary is a worse place for a key than a browser bundle: it ships
  // to an app store, cannot be rotated without a release, and is trivially
  // recovered from the IPA/APK. A browser-only check sails straight past it.
  //
  // Node defines `navigator` as a getter-only accessor, so a plain assignment
  // is silently ignored — it has to be redefined.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { product: 'ReactNative' },
    configurable: true,
    writable: true,
  });
  try {
    assert.throws(() => new Workser(BASE), BrowserSecretError);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
});
