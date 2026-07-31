# `workser.db` — the project's Postgres

Two ways in, and **the choice matters**:

- **`query()`** — goes through Core API. Scope-gated, audited, reachable from
  anywhere with a key. Right for agents and occasional access.
- **`connectionUri()`** — the raw Postgres URI for your own driver or ORM. Right for
  an app's hot path, where a round trip through Core API per query would be absurd.

```ts
import { workser } from '@workser/app';

const rows = await workser.db.query<Order>(
  'select * from orders where status = $1 limit $2',
  ['paid', 20],
);

await workser.db.tables();          // TableInfo[]
await workser.db.schema('orders');  // one table's columns
await workser.db.rows('orders', { limit: 50, offset: 0 });
```

## Parameterised SQL only

Parameters are sent separately and bound server-side. **Never interpolate user input
into the `sql` string.** This is the single most likely place for a generated app to
acquire an injection vulnerability, which is why the parameterised form is the only
one offered — don't build a concatenating helper on top of it.

```ts
// WRONG — an injection, however harmless the value looks today
await workser.db.query(`select * from orders where id = '${id}'`);

// RIGHT
await workser.db.query('select * from orders where id = $1', [id]);
```

## The connection URI is a credential

```ts
const { uri } = await workser.db.connectionUri();
```

Never return it to a browser, never log it, never put it in an agent's context. The
SDK's redaction masks it if it ends up inside an error — that's a backstop, not
permission.

A minted Data API token can only ever assume the project's least-privilege
`workser_app_<projectId>` role, never the owner, so it structurally cannot drop the
database regardless of the scope that minted it.

## Data API (PostgREST-compatible)

```ts
await workser.db.dataApiStatus();
const { token, expires_in } = await workser.db.mintDataApiToken(); // ≈5 min, least-privilege
```

## Notes that matter

- **The database belongs to the project, not this app.** Sibling apps share it.
  Namespace your tables; don't assume a name is free.
- Requires `infra-database:read` / `infra-database:write`.
- For business records — orders, carts, pages — use `workser.business` instead of
  raw SQL. It's the same data with a stable shape.
