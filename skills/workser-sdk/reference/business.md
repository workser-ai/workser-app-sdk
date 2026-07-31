# `workser.business` — the project's own records

Orders, sales, fulfillments, pages, carts. These are the **same rows** the Workser
dashboard and the user's AI employees read and write — not a copy, not an
integration. Never build a parallel table for something modelled here.

Every resource has the same five methods:

```ts
import { workser } from '@workser/app';

await workser.business.orders.list({ limit: 20, offset: 0 });
await workser.business.orders.get(id);
await workser.business.orders.create(body, { idempotencyKey: requestId });
await workser.business.orders.update(id, patch);
await workser.business.orders.remove(id);
```

Named resources: `orders`, `sales`, `fulfillments`, `pages`, `carts`.

## Typing the rows

Pass your own row type at the call site — the named accessors take a generic:

```ts
type Order = { id: string; total: number; status: string };

const recent = await workser.business.orders.list<Order>({ limit: 20 });
const one = await workser.business.orders.get<Order>(id);
```

## A resource this version doesn't name

Core API adds resources faster than the package is republished. Don't hand-roll a
`fetch` — the escape hatch keeps the same auth, retries and redaction:

```ts
const customers = await workser.business.resource<Customer>('customers').list();
```

## Notes that matter

- **Always pass `idempotencyKey` on `create`.** The SDK retries failed requests
  automatically, so a network timeout without a key can produce two orders. Use
  something stable for *this* attempt — a request id, an order number, a hash of the
  payload. Not a fresh UUID per retry.
- **`list` filters are pass-through.** Beyond `limit` and `offset`, any extra key
  goes to the API as a query parameter; check what the resource actually supports
  rather than assuming a filter silently applied.
- **`remove` is a real delete.** There's no undo here. For anything user-facing,
  prefer a status change via `update`.
- Requires `business:read` / `business:write` on the key. A `forbidden` error means
  the scope is missing, not that the row is.
