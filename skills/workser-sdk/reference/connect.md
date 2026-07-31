# `workser.connect` — Gmail, Slack, Sheets, Stripe

The value here: the **connection is owned by the project, not by the app**. An owner
connects Gmail once in Workser and every app in the project — the web app, the AI
agent, a worker — can send mail. No OAuth flow to implement, no tokens to store, no
refresh logic.

```ts
import { workser } from '@workser/app';

await workser.connect.connections({ toolkit: 'gmail' });  // what's actually connected
await workser.connect.toolkits();                          // everything connectable
await workser.connect.tools('gmail');                      // callable actions + schemas

await workser.connect.run('GMAIL_SEND_EMAIL',
  { to, subject, body },
  { idempotencyKey: orderId },
);
```

## The order to do things in

1. **`connections()` first.** Check what the project already has before offering a
   feature or asking the user for anything.
2. **Not connected?** `connect(toolkit)` returns a `redirect_url` the **user** must
   open — OAuth cannot be completed on their behalf, by design. Surface the link,
   wait, then continue.
3. **`tools(toolkitSlug)` before `run`.** The schema is what lets you construct valid
   arguments instead of guessing field names that will silently fail.
4. **`run(toolSlug, args, { idempotencyKey })`.**

## `run()` is a real side effect

It sends someone's real email, posts to their real Slack, charges a real card. Two
consequences:

- **Always pass `idempotencyKey`.** The SDK retries automatically; without a key a
  timeout sends the email twice. Key it on the thing that must happen once — an order
  id, a message id — not a fresh UUID.
- **Say what you're about to do before you do it**, and don't wire an untested
  workflow straight to a send action.

`disconnect(connectionId)` removes a connection for the **whole project**, not just
this app. Don't call it to clean up after yourself.

Requires `composio:read` / `composio:execute` / `composio:manage`.
