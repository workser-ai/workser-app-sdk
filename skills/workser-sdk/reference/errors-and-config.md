# Errors & running outside a Workser environment

## Every failure is a `WorkserError`

Branch on `err.code`. Never match message text — messages change, codes don't.

```ts
import { workser, WorkserError } from '@workser/app';

try {
  await workser.business.orders.create(order, { idempotencyKey: id });
} catch (err) {
  if (err instanceof WorkserError) {
    if (err.code === 'forbidden') { /* the key lacks that scope */ }
    if (err.retryable) { /* transient — already retried, safe to try later */ }
    console.error(err.summary());  // safe to log; credentials are redacted
  }
  throw err;
}
```

| Code | Means |
| --- | --- |
| `config` | The SDK was constructed wrong — missing project id or key |
| `unauthorized` | 401 — key missing, malformed, or revoked |
| `forbidden` | 403 — key is valid but lacks the scope for this call |
| `not_found` | 404 |
| `conflict` | 409 |
| `rate_limited` | 429 — retryable |
| `invalid_request` | A 4xx we didn't classify |
| `server_error` | 5xx — retryable |
| `timeout` | Exceeded `timeoutMs` — retryable |
| `network` | DNS/TLS/socket; the request never got a response |
| `unsupported` | The runtime can't do this safely — see `BrowserSecretError` |

Also on the error: `status`, `request` (`method`, `path`, `status`, `requestId`),
`details` (the server's parsed error body), `retryable`.

**`err.summary()` is the one to log.** It's a single redacted line. Logging the raw
error object, or a config that contains a key, is how a credential reaches a log
aggregator, a Sentry event, or an agent's context — and then has to be rotated.

`retryable` failures have **already** been retried (2 by default) before you see
them. Don't wrap the call in your own retry loop on top.

## `BrowserSecretError`

Constructing a client with a secret key in a browser **or React Native** throws. A
project key grants access to the whole project's business data, connected accounts
and storage; bundlers inline `process.env`, and a key in a mobile binary can't be
rotated without an app-store release.

The fix is never `allowBrowser: true` — it's to call Workser from your own server and
let the client talk to that.

## Running outside a Workser-provisioned environment

In the app, `import { workser }` needs no configuration. In a script or a test:

```ts
import { createClient } from '@workser/app';

const workser = createClient({
  projectId: 'proj_…',
  apiKey: process.env.WORKSER_API_KEY,
});
```

Environment variables the SDK reads, all injected automatically in a Workser app:

| Variable | Used for |
| --- | --- |
| `WORKSER_PROJECT_ID` | Which project the calls act on |
| `WORKSER_BUSINESS_API_KEY`, then `WORKSER_API_KEY` | Bearer key |
| `WORKSER_CORE_API_SERVICE_API_KEY` | Cloud key for db/storage/auth routes |
| `WORKSER_CORE_API_SERVICE_BASE_URL` | Core API base |
| `WORKSER_ORGANIZATION_ID` | Sent as `x-organization-id` when known |
| `WORKFLOW_BASE_URL`, `WORKFLOW_API_KEY` | Workflow service |

Other options: `timeoutMs` (default 30s), `maxRetries` (default 2), `headers` (never
put a credential here).

**The base URL must be https**, or loopback for local development. Anything else is
refused with `code: 'config'` rather than sending a key over plaintext.

## The singleton is lazy

`workser` is constructed on first property access, so importing the module can never
throw. A missing `WORKSER_PROJECT_ID` surfaces at the call that needed it, naming the
variable — not as an opaque module-load crash in a serverless cold start.
