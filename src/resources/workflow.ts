/**
 * Workflow automation.
 *
 * A separate service from Core API, with its own base URL and key — Workser
 * injects both (`WORKFLOW_BASE_URL`, `WORKFLOW_API_KEY`), so from an app's
 * point of view this is just another namespace.
 *
 * WHAT AN APP CAN ACTUALLY DO HERE
 *
 * The workflow service has two guards, and the difference decides this API:
 *
 *   • `/workflow-execution/*` — `ApiKeyGuard`, which accepts the key as
 *     `Authorization: Bearer`, `x-api-key` or `?api_key=`. This is what
 *     `WORKFLOW_API_KEY` opens, and it is how an app RUNS a workflow. The SDK
 *     sends `x-api-key`; any of the three works against the same guard.
 *   • `/workflow/*` and `/executions/*` — `AuthGuard`, which accepts a Supabase
 *     JWT or the PLATFORM-wide key. A per-project workflow key is neither, so
 *     listing and inspecting workflows 401s from an app.
 *
 * So this namespace exposes running a workflow and nothing else. Browse and
 * inspect workflows in Workser, where you are authenticated as yourself; an app
 * triggers what it was told to trigger.
 *
 * THE HALF PEOPLE FORGET
 *
 * A workflow-backed feature is TWO-WAY. Triggering is the outbound half. When
 * the workflow produces something the app needs — an async result, an inbound
 * message, a status change — its final node must POST back to a webhook route
 * in your app. Build only the trigger and the workflow runs perfectly while
 * nothing ever appears in the product. See `triggerAndForget`.
 */
import type { HttpClient } from '../http.js';
import { WorkserError } from '../errors.js';

export interface TriggerOptions {
  /**
   * Wait for the workflow's response node and return its data (default), or
   * return as soon as the run is accepted.
   *
   * `false` is right for anything slow — but the result then has to reach your
   * app some other way, which means a webhook. See the module note.
   *
   * SERVERLESS RISK: the default (`true`) holds your request open until the
   * workflow finishes. On Vercel a function that outlives its `maxDuration`
   * is killed, and the SDK's own per-request timeout (default 30 s) aborts the
   * call first — the workflow keeps running but your code sees a timeout. The
   * default is left as `true` because existing callers read the output from
   * the return value; for anything that can take more than a few seconds, pass
   * `wait: false` (or use `triggerAndForget`) and receive the result by webhook.
   */
  wait?: boolean;
  /**
   * Stable id for THIS trigger. The SDK retries failed requests, so without one
   * a timeout can start the workflow twice.
   */
  idempotencyKey?: string;
  /** Extra query parameters forwarded to the workflow. */
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * What a trigger returns.
 *
 * NOTE the envelope behaviour: when the service replies with a bare
 * `{ data: … }` and nothing else, the transport unwraps it, so you receive the
 * response node's data DIRECTLY rather than wrapped. When the reply carries
 * other fields alongside (`executionId`, `status`), it is passed through
 * untouched. Both shapes are normal; type the result at the call site when you
 * know which your workflow produces.
 */
export type TriggerResult = Record<string, unknown> & {
  executionId?: string;
  status?: string;
};

export class Workflows {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
    private readonly baseUrl: string | undefined,
    private readonly token: string | undefined,
  ) {}

  /**
   * Every method is `async` so a configuration problem arrives as a REJECTION
   * rather than a synchronous throw. Every other call in the SDK returns a
   * promise; if this one threw before returning one, an app written as
   * `workflows.trigger(...).catch(...)` would crash rather than catch.
   */
  private opts() {
    if (!this.baseUrl || !this.token) {
      throw new WorkserError(
        'Workflow automation is not configured for this project. Workser ' +
          'injects WORKFLOW_BASE_URL and WORKFLOW_API_KEY when the project has ' +
          'workflows enabled.',
        { code: 'config' },
      );
    }
    return {
      baseUrl: this.baseUrl,
      // The workflow service's ApiKeyGuard accepts Bearer, `x-api-key` and
      // `?api_key=`. We send `x-api-key` and keep `auth: 'none'` so the
      // transport does not ALSO attach the Core API business key as a bearer
      // token, which the workflow service would read as the wrong credential.
      auth: 'none' as const,
      headers: {
        'x-api-key': this.token,
        'x-project-id': this.projectId,
      },
    };
  }

  private waitParam(wait: boolean | undefined): 'true' | 'false' {
    return wait === false ? 'false' : 'true';
  }

  /**
   * Run a workflow.
   *
   * ```ts
   * const { data } = await workser.workflows.trigger('wf_123', { orderId });
   * ```
   *
   * Waits for the workflow's response node by default, matching the service's
   * own default — a call that silently returned nothing while the work happened
   * elsewhere would be the more surprising behaviour.
   */
  async trigger<R = TriggerResult>(
    workflowId: string,
    input: Record<string, unknown> = {},
    opts: TriggerOptions = {},
  ): Promise<R> {
    return this.http.request<R>(
      `/workflow-execution/${encodeURIComponent(workflowId)}`,
      {
        ...this.opts(),
        method: 'POST',
        body: input,
        query: { ...opts.query, wait: this.waitParam(opts.wait) },
        idempotencyKey: opts.idempotencyKey,
      },
    );
  }

  /**
   * Start a workflow and return immediately.
   *
   * Use for anything slow. The workflow's output will NOT come back through
   * this call — arrange for its final node to POST to a webhook route in your
   * app, guarded by a shared secret:
   *
   * ```ts
   * // app/api/webhooks/orders/route.ts
   * export async function POST(req: Request) {
   *   if (req.headers.get('x-webhook-secret') !== process.env.ORDERS_WEBHOOK_SECRET) {
   *     return new Response('Unauthorized', { status: 401 });
   *   }
   *   const payload = await req.json();
   *   // persist / update state / surface it in the UI
   *   return Response.json({ ok: true });
   * }
   * ```
   *
   * Skipping that receiver is the "it worked but nothing showed up" bug.
   */
  async triggerAndForget<R = TriggerResult>(
    workflowId: string,
    input: Record<string, unknown> = {},
    opts: Omit<TriggerOptions, 'wait'> = {},
  ): Promise<R> {
    return this.trigger<R>(workflowId, input, { ...opts, wait: false });
  }

  /**
   * Call a workflow with a verb other than POST.
   *
   * The execution endpoint is REST-shaped — GET reads, PUT/PATCH update, DELETE
   * removes — so a workflow can back a whole resource rather than only a
   * "run this" button.
   */
  async call<T = unknown>(
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
    workflowId: string,
    input: Record<string, unknown> = {},
    opts: TriggerOptions = {},
  ): Promise<T> {
    const base = this.opts();
    const wait = this.waitParam(opts.wait);
    return this.http.request<T>(
      `/workflow-execution/${encodeURIComponent(workflowId)}`,
      method === 'GET'
        ? {
            ...base,
            method,
            // GET carries no body; its inputs travel as query parameters.
            query: { ...opts.query, ...toQuery(input), wait },
          }
        : {
            ...base,
            method,
            body: input,
            query: { ...opts.query, wait },
            idempotencyKey: opts.idempotencyKey,
          },
    );
  }
}

function toQuery(
  input: Record<string, unknown>,
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    out[k] =
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        ? v
        : JSON.stringify(v);
  }
  return out;
}
