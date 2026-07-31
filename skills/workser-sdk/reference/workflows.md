# `workser.workflows` — hand work off so it outlives the request

```ts
import { workser } from '@workser/app';

// waits for the workflow's response node (default)
const result = await workser.workflows.trigger('wf_123', { orderId }, {
  idempotencyKey: orderId,
});

// starts it and returns immediately
await workser.workflows.triggerAndForget('wf_123', { orderId }, { idempotencyKey: orderId });

// the execution endpoint is REST-shaped
await workser.workflows.call('GET', 'wf_123', { since });
```

## An app can run a workflow — and nothing else

The workflow service has two guards:

- `/workflow-execution/*` — reads `x-api-key`. This is what `WORKFLOW_API_KEY` opens,
  and it is how an app **runs** a workflow.
- `/workflow/*` and `/executions/*` — needs a user JWT or the platform-wide key. A
  per-project workflow key is neither, so **listing or inspecting workflows 401s from
  an app**.

Browse and inspect workflows in Workser (or with `workser workflow list` from the
CLI, where you're authenticated as yourself). An app triggers what it was told to
trigger. If a `workflows.list()` seems to be missing, it's absent on purpose.

## The half people forget

A workflow-backed feature is **two-way**. Triggering is the outbound half. When the
workflow produces something the app needs — an async result, an inbound message, a
status change — its final node must POST back to a webhook route in your app:

```ts
// app/api/webhooks/orders/route.ts
export async function POST(req: Request) {
  if (req.headers.get('x-webhook-secret') !== process.env.ORDERS_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  const payload = await req.json();
  // persist / update state / surface it in the UI
  return Response.json({ ok: true });
}
```

Build only the trigger and the workflow runs perfectly while nothing ever appears in
the product. That's the "it worked but nothing showed up" bug.

## Notes that matter

- **`wait: true` is the default.** Use `triggerAndForget` for anything slow — but
  then the result has to reach you via the webhook above.
- **Always pass `idempotencyKey`.** The SDK retries, so a timeout can start the
  workflow twice.
- **The return shape varies.** A bare `{ data: … }` reply is unwrapped, so you get
  the response node's data directly; a reply carrying `executionId` / `status`
  alongside is passed through untouched. Both are normal — type the result at the
  call site.
- **Not configured?** You get a `WorkserError` with `code: 'config'` as a rejection.
  Workser injects `WORKFLOW_BASE_URL` and `WORKFLOW_API_KEY` when the project has
  workflows enabled.
