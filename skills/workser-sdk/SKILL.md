---
name: workser-sdk
description: Write app code that reads and writes the project's own data — orders, database, storage, users, connected apps like Gmail or Stripe — using the @workser/app SDK. Use when building a page, an API route, a server action or a job that needs the project's real business data at runtime. NOT for deploying or provisioning; that is the `workser` CLI skill.
---

# @workser/app — the project's data, from inside the app

`@workser/app` is how the code you write reaches the project's own records at
runtime. The `workser` CLI operates the app from the outside (provision, deploy,
set env); this runs *inside* it, on every request.

Reach for it whenever a feature needs real data: "list my orders", "save this
customer", "email the owner a summary", "store the uploaded file".

## Zero configuration

Workser provisions the project's credentials into the app's environment, so there
is nothing to wire up and no key to paste:

```ts
import { workser } from '@workser/app';

const orders = await workser.business.orders.list({ limit: 20 });
```

If `@workser/app` is not in `package.json` yet: `npm install @workser/app`.

## Read one reference file, not all of them

This page is the index. Each namespace has its own file under `reference/` (next to
this one), self-contained and about one screen long. Find your row, read that **one**
file — you are paying for every line you load.

| You need to… | Namespace | Read |
| --- | --- | --- |
| Read or write orders, sales, carts, pages, fulfillments | `workser.business` | `reference/business.md` |
| Run SQL, list tables, get a connection URI for an ORM | `workser.db` | `reference/db.md` |
| Store or serve a file — images, uploads, PDFs | `workser.storage` | `reference/storage.md` |
| Look up the project's end users | `workser.auth` | `reference/auth.md` |
| Send mail, post to Slack, write a Sheet, call Stripe | `workser.connect` | `reference/connect.md` |
| Hand work off so it outlives the request | `workser.workflows` | `reference/workflows.md` |
| Run an AI agent for the user and stream what it does | `workser.agents` | `reference/agents.md` |
| Use the project's own Neon buckets or functions | `workser.neon` | `reference/neon.md` |
| Handle a failure, or run outside a Workser environment | `WorkserError`, `createClient` | `reference/errors-and-config.md` |

## Rules that will bite you if you ignore them

These apply to every namespace. Don't skip them because you only read one file.

1. **Server-side only.** A Workser key grants access to a whole project, and
   bundlers inline `process.env`. The SDK **throws** rather than run in a browser
   or React Native with a secret key. Call it from a server component, route
   handler, server action or job — never from a client component.
2. **Parameterised SQL only.** `workser.db.query(sql, params)` binds server-side.
   There is deliberately no string-concatenation API; do not build one by
   interpolating into the `sql` string.
3. **Idempotency keys on writes.** The SDK retries automatically, so a create
   without one can become two orders:
   ```ts
   await workser.business.orders.create(order, { idempotencyKey: requestId });
   ```
4. **Branch on `err.code`, never on message text.** Every failure is a
   `WorkserError` with a stable code. See `reference/errors-and-config.md`.
5. **Never log a raw error object or a config containing a key.** `err.summary()`
   is the redacted form and is the one to log.
6. **Files go to `workser.storage` — and never to the app's own filesystem.**
   `workser.storage` is the default; if the owner asked for their own S3 or
   Cloudinary, build that instead. What is never an option either way is
   `fs.writeFile` or an upload handler saving next to the code: the host is
   serverless, so what you wrote is gone at the end of the request, and anything
   under `public/` is committed and rides in every deploy for ever. Store it,
   keep the returned key or URL, and serve that.

## These are the project's real records

`workser.business` reads **the same rows** the Workser dashboard and the user's AI
employees read and write. An app built on Workser is not integrating with a separate
system — it is reading its own business. Do not build a parallel table for something
`workser.business` already models.

## When this version doesn't name what you need

Core API moves faster than the package is republished. Do not hand-roll a `fetch`
with your own auth — use the escape hatches, which keep the same auth, retries and
redaction:

```ts
await workser.business.resource('customers').list();   // an unnamed business resource
await workser.request('/v1/projects/…/something-new');  // any Core API route
```

## Which tool for which job

- Needs to happen **when a user hits the app** → `@workser/app` (this skill).
- Needs to happen **to the app** — provision the database, set an env var, deploy,
  read logs → the `workser` CLI skill.
- Needs to keep running **after you finish** → `workser.workflows`, or
  `workser workflow create` from the CLI.

A common mistake is using the CLI to fetch data the app should be fetching itself:
`workser db query` is for you to inspect the database while building, not for the app
to read its own data at runtime.

## Requirements

Node 18+ (or Bun/Deno, or any runtime with `fetch`). Zero runtime dependencies.
