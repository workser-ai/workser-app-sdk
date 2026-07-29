/**
 * Workflow automation.
 *
 * A separate service from Core API, with its own base URL and key — Workser
 * injects both (`WORKFLOW_BASE_URL`, `WORKFLOW_API_KEY`), so from an app's
 * point of view it is just another namespace.
 *
 * The point of this namespace is that an app can HAND WORK OFF. A checkout
 * route does not need to send the confirmation email, update the sheet and
 * notify Slack inline; it triggers a workflow and returns. The automation
 * outlives the request.
 */
import type { HttpClient } from '../http.js';
import { WorkserError } from '../errors.js';

export interface Workflow {
  id: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export interface Execution {
  id: string;
  status?: string;
  created_at?: string;
  [key: string]: unknown;
}

export class Workflows {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
    private readonly baseUrl: string | undefined,
    private readonly token: string | undefined,
  ) {}

  /**
   * Every method here is `async` so that this configuration error arrives as a
   * REJECTION, not a synchronous throw. Every other call in the SDK returns a
   * promise; if this one threw before returning one, an app written as
   * `workflows.list().catch(...)` would crash rather than catch, and that
   * inconsistency is exactly the kind of thing nobody discovers until it is in
   * production.
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
    return { baseUrl: this.baseUrl, token: this.token };
  }

  async list(): Promise<Workflow[]> {
    return this.http.request<Workflow[]>('/workflows', {
      ...this.opts(),
      query: { projectId: this.projectId },
    });
  }

  async get(workflowId: string): Promise<Workflow> {
    return this.http.request<Workflow>(
      `/workflows/${encodeURIComponent(workflowId)}`,
      this.opts(),
    );
  }

  /**
   * Start a workflow and return immediately.
   *
   * Fire-and-forget by design: the execution outlives this request, which is
   * the entire reason to use a workflow rather than doing the work inline.
   * Poll `execution()` if you need the outcome.
   */
  async trigger(
    workflowId: string,
    input: Record<string, unknown> = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<Execution> {
    return this.http.request<Execution>(
      `/executions/trigger/${encodeURIComponent(workflowId)}`,
      {
        ...this.opts(),
        method: 'POST',
        body: { projectId: this.projectId, input },
        idempotencyKey: opts.idempotencyKey,
      },
    );
  }

  async execution(executionId: string): Promise<Execution> {
    return this.http.request<Execution>(
      `/executions/${encodeURIComponent(executionId)}`,
      this.opts(),
    );
  }

  async executions(workflowId: string, params: { limit?: number } = {}): Promise<Execution[]> {
    return this.http.request<Execution[]>(
      `/executions`,
      { ...this.opts(), query: { workflowId, ...params } },
    );
  }
}
