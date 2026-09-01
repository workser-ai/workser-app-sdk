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

## Ask before you act

The commonest failure is not a bug in your code: the owner has not connected the
account yet, and you find out *after* the user pressed the button. Three ways to
find out first, cheapest last:

```ts
await workser.connect.isConnected('gmail');   // boolean; INITIATED does not count
await workser.connect.connected();            // ['gmail','googlesheets'] — one call
await workser.connect.requireConnection('gmail');  // throws a sentence you can show
await workser.connect.safeRun('GMAIL_SEND_EMAIL', args, { idempotencyKey });
```

**`safeRun` is the one to reach for.** It derives the account from the action slug
(`GMAIL_SEND_EMAIL` → `gmail`), checks it, and only then acts. When the account is
missing it throws a `WorkserError` (`code: 'forbidden'`) whose message names the
account and says the **project owner** connects it in Workser — which matters,
because the person reading your error page cannot do it themselves.

A slug with no underscore has no derivable toolkit, so `safeRun` just runs. Pass
`{ toolkit }` explicitly for those.

## The order to do things in

1. **`isConnected()` / `connected()` first.** Check what the project already has
   before offering a feature or asking the user for anything.
2. **Not connected?** `connect(toolkit)` returns a `redirect_url` the **user** must
   open — OAuth cannot be completed on their behalf, by design. Surface the link,
   wait, then continue.
3. **`tools(toolkitSlug)` before `run`.** The schema is what lets you construct valid
   arguments instead of guessing field names that will silently fail.
4. **`safeRun(toolSlug, args, { idempotencyKey })`**, or `run()` when you have
   already checked and want the raw upstream error.

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
