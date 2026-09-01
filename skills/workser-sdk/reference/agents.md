# `workser.agents` — Agent Cloud

An agent that runs on Workser's infrastructure, called from this app. It gets
its own sandbox, its own tools and its own memory, and it may work for up to
two hours on a single request — so it cannot run inside your request handler.

The shape is always **start a run, then watch it**.

```ts
import { workser } from '@workser/app';

const run = await workser.agents.run(agentId, { message: 'Reconcile March' });

for await (const event of workser.agents.stream(run.id)) {
  console.log(event.type, event.data);
}
```

`run()` returns as soon as the work is accepted. The run has not finished.

## Streaming to a browser

This is the main reason to use the SDK rather than plain REST. Forward the
events to the page and the person watching sees the agent think:

```ts
// app/api/agent/[runId]/route.ts
export async function GET(_req: Request, { params }) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for await (const event of workser.agents.stream(params.runId)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
```

The stream **reconnects itself**. A two-hour run will be interrupted — a load
balancer idle timeout, a redeploy — and `stream()` resumes from the last event
it handed you, so your loop sees no gap and no duplicate. Do not write
reconnection logic around it.

## Waiting, for a job with nowhere to stream to

```ts
const finished = await workser.agents.runAndWait(agentId, { message: '...' }, {
  onEvent: (e) => console.log(e.type),
});
console.log(finished.output);
```

## The methods

| Call | What it does |
| --- | --- |
| `agents.list()` | The agents this project ships |
| `agents.get(agentId)` | One agent and its configuration |
| `agents.run(agentId, input, opts?)` | Start a run; returns immediately |
| `agents.stream(runId, opts?)` | Async iterator of events, resumable |
| `agents.runAndWait(agentId, input, opts?)` | Start, wait, return the finished run |
| `agents.listRuns({ agentId, limit })` | Recent runs, newest first |
| `agents.getRun(runId)` | One run with steps, messages, artifacts, cost |
| `agents.cancelRun(runId)` | Stop a run and release its sandbox |

## When the agent serves your end users

An agent acting for a customer must be attributable to that customer, or its
memory and its audit trail belong to nobody. Pass who it is for:

```ts
await workser.agents.run(agentId, { message }, { referenceUserId: user.id });
```

Core API **requires** this for PRODUCT-variant agents. Reuse `sessionId` from a
previous run to continue the same conversation.

## Things that will bite you

1. **A run costs money and may send real email.** The SDK attaches a fresh
   idempotency key per call, so an automatic retry after a timeout resumes the
   same run rather than starting a second. If your own dedupe rule is about
   content — one run per customer order — pass `idempotencyKey` yourself.

2. **Cancel what you abandon.** `cancelRun()` releases the agent's sandbox.
   A run nobody is watching is still being billed by the minute.

3. **`run.cost_usd` is the model cost only.** Runtime and workspace minutes are
   metered separately and appear on the organization's cloud usage, not on the
   run.

4. **Never stream to the browser directly from `@workser/app`.** The key grants
   access to the whole project. Proxy it through your own route, as above.

5. **A stream that ends is not the same as a run that finished.** `stream()`
   throws rather than ending quietly when it cannot follow a live run — treat
   that as "unknown", read the run with `getRun()`, and never report success
   because the loop ended.
