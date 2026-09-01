# @workser/app

One client for everything a Workser project owns — its database, business data,
connected apps, files, users and workflow automation.

```bash
npm install @workser/app
```

## Zero configuration

Workser provisions your project's credentials into every app's environment, so
there is nothing to wire up:

```ts
import { workser } from '@workser/app';

const orders = await workser.business.orders.list({ limit: 20 });
await workser.connect.run('GMAIL_SEND_EMAIL', {
  to: 'owner@shop.com',
  subject: 'Daily summary',
  body: `${orders.length} orders today.`,
});
```

No API keys in source. No setup step. Nothing for a non-technical owner to paste.

Outside a Workser-provisioned environment, configure it explicitly:

```ts
import { createClient } from '@workser/app';
const workser = createClient({ projectId: 'proj_…', apiKey: process.env.WORKSER_API_KEY });
```

## What you get

| Namespace | What it reaches |
| --- | --- |
| `workser.business` | Orders, sales, fulfillments, pages, carts — the project's own records |
| `workser.connect` | Gmail, Slack, Sheets, Stripe … connected once, usable by every app |
| `workser.db` | The project's Postgres database |
| `workser.storage` | Project file storage |
| `workser.auth` | The project's end users |
| `workser.workflows` | Automations that outlive the request |
| `workser.agents` | Agents that run on Workser's infrastructure, with a resumable event stream |

The point is that these are **the same records** the Workser dashboard and your
AI employees read and write. An app built on Workser is not integrating with a
separate system — it is reading its own business.

## Connected apps

The connection belongs to the **project**, not to your app. The owner connects
Gmail once in Workser; every app in the project can send mail. No OAuth flow to
implement, no tokens to store, no refresh logic.

The one thing worth handling is that the owner may not have connected the
account yet — and finding that out *after* your user pressed the button is the
bad version:

```ts
// Ask first, so you can hide or disable the feature.
if (await workser.connect.isConnected('gmail')) {
  showEmailReceiptButton();
}

// Or build the whole menu from one call.
const accounts = await workser.connect.connected();   // ['gmail', 'googlesheets']

// Or just act, and get a sentence you can show a person if it is missing.
await workser.connect.safeRun('GMAIL_SEND_EMAIL', {
  to: 'owner@shop.com',
  subject: 'Daily summary',
  body: '12 orders today.',
}, { idempotencyKey: `summary-${today}` });
```

`safeRun` derives the account from the action slug (`GMAIL_SEND_EMAIL` → Gmail),
checks it, and only then acts. When it is missing it throws a `WorkserError`
whose message names the account and says the **project owner** connects it in
Workser — because the person reading your error page cannot.

`run()` is still there when you have already checked, or when you want the raw
upstream error. Both take `idempotencyKey`, which is how an automatic retry
stops sending the same email twice.

## Security

This SDK is used by AI agents, so anything it returns can end up in a model's
context window, a transcript, or a log. It is built accordingly:

- **Refuses to hold a secret key in a browser.** A Workser key grants access to
  a whole project. Bundlers inline `process.env`, so the SDK throws rather than
  trusting that you meant it. Call Workser from your server.
- **Refuses to send a key over plaintext** to anything but loopback.
- **Never logs or embeds a credential.** Keys live only in the `Authorization`
  header; errors are redacted, and fields named like secrets are dropped
  entirely rather than masked.
- **Parameterised SQL only.** `db.query(sql, params)` binds server-side; there is
  no string-concatenation API to reach for.
- **Idempotency keys on writes.** The SDK retries automatically, so a create
  without one can become two orders. Pass `{ idempotencyKey }`.

Every one of these is covered by a test in `test/security.test.ts`.

## Errors

Every failure is a `WorkserError` with a stable `code` — branch on that, never
on message text:

```ts
import { WorkserError } from '@workser/app';

try {
  await workser.business.orders.create(order, { idempotencyKey: id });
} catch (err) {
  if (err instanceof WorkserError) {
    if (err.code === 'forbidden') { /* key lacks the scope */ }
    if (err.retryable) { /* transient — already retried, safe to try later */ }
    console.error(err.summary()); // safe to log
  }
}
```

Codes: `config`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `invalid_request`, `server_error`, `timeout`, `network`,
`unsupported`.

## Escape hatches

Core API moves faster than this package is republished, and being blocked on an
npm release to reach an endpoint you already own would be a bad trade:

```ts
// A business resource this version doesn't name yet
await workser.business.resource('customers').list();

// Any Core API route, with the same auth, retries and redaction
await workser.request('/v1/projects/…/something-new');
```

## Requirements

Node 18+ (or Bun, Deno, or any runtime with `fetch`). **Zero runtime
dependencies.**

## Development

```bash
npm run typecheck
npm test          # compiles, then runs against the built output
npm run build
```
