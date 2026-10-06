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

## When your OWN users bring their own accounts

Everything above is the project's connection: the owner links Gmail once and the
whole project sends mail from it. That is right for a back-office job and wrong
for a multi-tenant app — a CRM you built for ten customers should not send all
their mail from your inbox.

Pass `referenceUserId` — your own id for the end user — and the call is about
*their* account instead:

```ts
await workser.connect.isConnected('gmail', { referenceUserId: user.id });
await workser.connect.connect('gmail', { referenceUserId: user.id, redirectUrl });
await workser.connect.safeRun('GMAIL_SEND_EMAIL', args, {
  referenceUserId: user.id,
  idempotencyKey: order.id,
});
```

Three things to know:

- **Pass it everywhere or nowhere for a given call.** `safeRun` checks and acts
  in the same account, so passing it once is enough there — but a bare
  `isConnected('gmail')` followed by a scoped `run()` is a guard that passed on
  somebody else's connection.
- **The error changes with it.** `requireConnection` tells the *end user* to link
  their own account when scoped, and names the *project owner* when it is not —
  the two failures need different next steps from different people.
- **The server insists.** Once a project has any reference-user connection for a
  toolkit, an unscoped `run()` on it fails with `400 REFERENCE_USER_ID_REQUIRED`.
  The API will not guess whose account you meant.

Use a stable id — whatever your own database uses. The string that linked the
account has to be the string that acts in it.

Requires `composio:read` / `composio:execute` / `composio:manage`.
