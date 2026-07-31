# `workser.auth` — the project's end users

Read-oriented **on purpose**.

```ts
import { workser } from '@workser/app';

await workser.auth.status();                          // provisioned? how configured?
await workser.auth.users({ limit: 50, offset: 0 });   // AuthUser[]
```

`AuthUser`: `id`, `email?`, `name?`, `created_at?`, plus whatever else the project
stores.

## What this is not

Sign-in, sessions, password handling and OAuth belong to **Better Auth in the app
itself** — that's what the template wires up, and it runs against the project's
database. What an app or an agent needs from this namespace is "who are my users"
and "is auth switched on".

If a task is "add login", the work is in the app's Better Auth setup, not here. If
auth isn't provisioned yet, `workser auth enable` from the CLI provisions it (see the
`workser` skill).

## Notes that matter

- **`users()` is paginated.** Default page size is the server's, not "everyone" —
  loop with `offset` if you genuinely need all of them, and think about whether you
  do before pulling a customer list into an agent's context.
- **A user list is personal data.** Don't log it, don't paste it into the
  conversation, don't hand it to a third-party tool without the user asking.
- Requires `infra-auth:read` / `infra-auth:write`.
