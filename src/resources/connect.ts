/**
 * Connected apps — Gmail, Slack, Sheets, Stripe and the rest, via Composio.
 *
 * The value here is that the CONNECTION is owned by the project, not by the
 * app. An owner connects Gmail once in Workser and every app in the project —
 * the web app, the AI agent, a worker — can send mail. No OAuth flow to
 * implement, no tokens to store, no refresh logic.
 *
 * Requires `composio:read` / `composio:execute` / `composio:manage`.
 */
import type { HttpClient } from '../http.js';

export interface Toolkit {
  slug: string;
  name?: string;
  [key: string]: unknown;
}

export interface Connection {
  id: string;
  toolkit?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ToolSchema {
  slug: string;
  name?: string;
  description?: string;
  input_parameters?: unknown;
  [key: string]: unknown;
}

export class Connect {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
  ) {}

  private base(): string {
    return `/v1/projects/${encodeURIComponent(this.projectId)}/composio`;
  }

  /** Everything connectable, whether connected or not. */
  toolkits(): Promise<Toolkit[]> {
    return this.http.request<Toolkit[]>(`${this.base()}/toolkits`);
  }

  /**
   * A toolkit's callable actions and their argument schemas.
   *
   * Worth calling before `run()` from an agent: the schema is what lets a
   * model construct valid arguments instead of guessing field names.
   */
  tools(toolkitSlug: string): Promise<ToolSchema[]> {
    return this.http.request<ToolSchema[]>(
      `${this.base()}/toolkits/${encodeURIComponent(toolkitSlug)}/tools`,
    );
  }

  /** What this project has actually connected — check before offering a feature. */
  connections(params: { toolkit?: string } = {}): Promise<Connection[]> {
    return this.http.request<Connection[]>(`${this.base()}/connections`, {
      query: params,
    });
  }

  /**
   * Begin connecting a toolkit. Returns a redirect URL the USER must open —
   * OAuth cannot be completed on their behalf, by design.
   */
  connect(toolkit: string, opts: { redirectUrl?: string } = {}): Promise<{
    redirect_url?: string;
    [key: string]: unknown;
  }> {
    return this.http.request(`${this.base()}/connect`, {
      method: 'POST',
      body: { toolkit, redirect_url: opts.redirectUrl },
    });
  }

  disconnect(connectionId: string): Promise<void> {
    return this.http.request<void>(
      `${this.base()}/connections/${encodeURIComponent(connectionId)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * Execute one action, e.g. `run('GMAIL_SEND_EMAIL', { to, subject, body })`.
   *
   * This is a real side effect in someone's real account. `idempotencyKey` is
   * how you stop an automatic retry from sending the same email twice.
   */
  run<T = unknown>(
    toolSlug: string,
    args: Record<string, unknown> = {},
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    return this.http.request<T>(
      `${this.base()}/tools/${encodeURIComponent(toolSlug)}/execute`,
      {
        method: 'POST',
        body: { arguments: args },
        idempotencyKey: opts.idempotencyKey,
      },
    );
  }
}
