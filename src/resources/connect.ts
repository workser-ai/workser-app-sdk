/**
 * Connected apps — Gmail, Slack, Sheets, Stripe and the rest, via Composio.
 *
 * The value here is that the CONNECTION is owned by the project, not by the
 * app. An owner connects Gmail once in Workser and every app in the project —
 * the web app, the AI agent, a worker — can send mail. No OAuth flow to
 * implement, no tokens to store, no refresh logic.
 *
 * Requires `composio:read` / `composio:execute` / `composio:manage`.
 *
 * ─── TWO SCOPES OF CONNECTION, AND WHY EVERY METHOD TAKES `referenceUserId` ───
 *
 * The paragraph above describes the common case: the OWNER connects Gmail once
 * and the whole project can send mail. There is a second case the API has
 * always supported and this class could not reach — an app that is itself
 * multi-tenant, where each of YOUR OWN end-users links THEIR OWN account. A
 * CRM you built for ten customers does not want to send all their mail from
 * your inbox.
 *
 * The server calls that a REFERENCE_USER-scoped connection and keys it on an id
 * you choose (your own user id). Passing it changes WHOSE account is acted in;
 * omitting it means the project's own.
 *
 * It was previously reachable only through `workser.request(...)`, which meant
 * dropping out of the typed surface — and, worse, that the moment a project had
 * any reference-user connection for a toolkit, a plain `run()` started failing
 * with `400 REFERENCE_USER_ID_REQUIRED`. The API insists on knowing whose
 * account you mean, and the SDK had no way to say.
 */
import type { HttpClient } from '../http.js';
import { WorkserError } from '../errors.js';

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

/**
 * WHOSE ACCOUNT this call is about.
 *
 * One option, shared by every method that can be asked about either scope, so
 * "the project's Gmail" and "this customer's Gmail" are the same call with one
 * field changed rather than two APIs to learn.
 *
 * Omitted means the PROJECT's own connection — the common case, and the one
 * every existing caller already gets, unchanged.
 */
export interface ConnectionScope {
  /**
   * Your own id for one of your app's end-users.
   *
   * Whatever you use in your own database is fine; it is an opaque key to
   * Workser. What matters is that it is stable — the same string that linked
   * the account has to be the one that acts in it, or you are asking about
   * somebody who has connected nothing.
   */
  referenceUserId?: string;
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

  /**
   * What this project has actually connected — check before offering a feature.
   *
   * `referenceUserId` asks about ONE of your end-users' own connections
   * instead of the project's. Different question, different answer: a project
   * with Gmail connected does not mean this particular customer has linked
   * theirs.
   */
  connections(params: ConnectionScope & { toolkit?: string } = {}): Promise<Connection[]> {
    return this.http.request<Connection[]>(`${this.base()}/connections`, {
      query: {
        toolkit: params.toolkit,
        reference_user_id: params.referenceUserId,
      },
    });
  }

  /**
   * Begin connecting a toolkit. Returns a redirect URL the USER must open —
   * OAuth cannot be completed on their behalf, by design.
   */
  connect(
    toolkit: string,
    opts: ConnectionScope & { redirectUrl?: string } = {},
  ): Promise<{
    redirect_url?: string;
    [key: string]: unknown;
  }> {
    return this.http.request(`${this.base()}/connect`, {
      method: 'POST',
      body: {
        toolkit,
        redirect_url: opts.redirectUrl,
        // Present ⇒ this OAuth links that end-user's own account. Absent ⇒ the
        // project's. It is the same flow either way; the id is what decides
        // whose mailbox comes out the other end.
        reference_user_id: opts.referenceUserId,
      },
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
   *
   * **The failure worth handling is 404-shaped, not 500-shaped.** The commonest
   * reason this call fails is that the owner has not connected the account yet,
   * and the raw upstream error for that reads like a bug in your code. Prefer
   * `isConnected()` before offering the feature, or `requireConnection()` when
   * you would rather fail loudly with a sentence you can show the user.
   */
  run<T = unknown>(
    toolSlug: string,
    args: Record<string, unknown> = {},
    opts: ConnectionScope & { idempotencyKey?: string } = {},
  ): Promise<T> {
    return this.http.request<T>(
      `${this.base()}/tools/${encodeURIComponent(toolSlug)}/execute`,
      {
        method: 'POST',
        body: { arguments: args, reference_user_id: opts.referenceUserId },
        idempotencyKey: opts.idempotencyKey,
      },
    );
  }

  /* ────────────────────── asking before acting ──────────────────────
   *
   * Everything above is the raw surface. Everything below exists because the
   * raw surface has one sharp edge that every app hits: an action against an
   * account nobody has connected fails at the worst possible moment — after
   * the user pressed the button — with an error written for an API client.
   *
   * A connected account is a fact about the OWNER'S setup, not about your
   * code, so it should be checkable before you offer the feature at all.
   * ───────────────────────────────────────────────────────────────── */

  /**
   * Is this toolkit usable right now?
   *
   * Checks for a connection that is actually ACTIVE — a half-finished OAuth
   * leaves a row behind in `INITIATED`, and treating that as connected is how
   * a feature appears enabled and then fails on first use.
   *
   * Never throws for "not connected": that is an answer, not an error. It does
   * still throw if the project cannot be reached at all, because pretending a
   * network failure means "not connected" would have you hide a feature the
   * owner has paid for.
   */
  async isConnected(toolkit: string, opts: ConnectionScope = {}): Promise<boolean> {
    const list = await this.connections({
      toolkit,
      referenceUserId: opts.referenceUserId,
    });
    return list.some((c) => isActive(c));
  }

  /**
   * Every toolkit this project can actually act in, as slugs.
   *
   * The one call to make when you are deciding what to show: `['gmail',
   * 'googlesheets']` is enough to build a menu, and it costs one request
   * instead of one per feature.
   */
  async connected(opts: ConnectionScope = {}): Promise<string[]> {
    const list = await this.connections({ referenceUserId: opts.referenceUserId });
    const slugs = new Set<string>();
    for (const c of list) {
      if (!isActive(c)) continue;
      const slug = toolkitSlug(c);
      if (slug) slugs.add(slug);
    }
    return [...slugs].sort();
  }

  /**
   * Assert a toolkit is connected, or throw something you can show a person.
   *
   * The message names the account and says who has to fix it, because the
   * person reading your error page cannot connect it themselves — the owner
   * does that in Workser, in front of an OAuth screen. An error that says
   * `403 composio` sends them to you; this one sends them to the right place.
   */
  async requireConnection(toolkit: string, opts: ConnectionScope = {}): Promise<void> {
    if (await this.isConnected(toolkit, opts)) return;
    /**
     * WHO HAS TO GO AND FIX IT is a different person in the two scopes, and
     * this message's whole job is to name them.
     *
     * For a project connection it is the owner, in Workser. For a
     * reference-user connection it is the END USER reading the page — they
     * have to complete the OAuth themselves, and telling them to contact the
     * project owner sends them somewhere that cannot help. Same failure, two
     * different next steps.
     */
    throw new WorkserError(
      opts.referenceUserId
        ? `This needs a connected ${prettyToolkit(toolkit)} account. Link ` +
            `yours to continue — nobody can do it on your behalf.`
        : `This needs a connected ${prettyToolkit(toolkit)} account, and this ` +
            `project does not have one yet. The project owner can connect it in ` +
            `Workser under Connections — it is not something this app can do on ` +
            `their behalf.`,
      {
        code: 'forbidden',
        details: { toolkit, referenceUserId: opts.referenceUserId },
      },
    );
  }

  /**
   * Run an action, but check the connection first.
   *
   * The convenience that makes the difference in practice: one call, and a
   * failure that is either a real failure or a sentence naming the missing
   * account. The extra request is one GET against a small list, which is the
   * right trade against acting on someone's mail account and finding out
   * afterwards.
   *
   * `toolkitOf` derives the toolkit from the action slug — `GMAIL_SEND_EMAIL`
   * is Gmail — so you do not have to pass it twice. Pass `toolkit` explicitly
   * when the slug does not follow that shape.
   */
  async safeRun<T = unknown>(
    toolSlug: string,
    args: Record<string, unknown> = {},
    opts: ConnectionScope & { idempotencyKey?: string; toolkit?: string } = {},
  ): Promise<T> {
    const toolkit = opts.toolkit ?? toolkitOf(toolSlug);
    /**
     * THE CHECK AND THE RUN MUST ASK ABOUT THE SAME ACCOUNT.
     *
     * This is the reason the scope is threaded all the way down rather than
     * only onto `run()`. With it on the run alone, `safeRun` would confirm the
     * PROJECT has Gmail and then send mail as one of your customers — a guard
     * that passes on the strength of somebody else's connection is worse than
     * no guard, because it reads as having been checked.
     */
    if (toolkit) await this.requireConnection(toolkit, opts);
    return this.run<T>(toolSlug, args, {
      idempotencyKey: opts.idempotencyKey,
      referenceUserId: opts.referenceUserId,
    });
  }
}

/* ─────────────────────────── small, tested helpers ─────────────────────── */

/**
 * Connected, in the several spellings the API uses.
 *
 * Composio has said `ACTIVE`, `active` and `connected` at different times, and
 * a project's connection row can also be `INITIATED` (OAuth started, never
 * finished) or `FAILED`. Only the first group can actually run anything.
 */
export function isActive(connection: Connection): boolean {
  const status = String(connection?.status ?? '').toLowerCase();
  return status === 'active' || status === 'connected' || status === 'enabled';
}

/** The toolkit a connection belongs to, in the several shapes the API uses. */
export function toolkitSlug(connection: Connection): string | null {
  const raw =
    connection?.toolkit ??
    (connection as Record<string, unknown>)?.toolkit_slug ??
    (connection as Record<string, unknown>)?.appName ??
    (connection as Record<string, unknown>)?.slug;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value || null;
}

/**
 * The toolkit an action slug belongs to: `GMAIL_SEND_EMAIL` → `gmail`.
 *
 * Composio names every action `<TOOLKIT>_<VERB>`, so the first segment is the
 * toolkit. Returns null rather than guessing when the slug has no underscore —
 * a wrong toolkit here would make `safeRun` check the wrong account and refuse
 * a call that would have worked.
 */
export function toolkitOf(toolSlug: string): string | null {
  const first = String(toolSlug ?? '').trim().split('_')[0];
  return first && first !== toolSlug ? first.toLowerCase() : null;
}

/** `googlesheets` → `Google Sheets`. For a sentence a person reads. */
export function prettyToolkit(toolkit: string): string {
  const known: Record<string, string> = {
    gmail: 'Gmail',
    googlesheets: 'Google Sheets',
    googledrive: 'Google Drive',
    googlecalendar: 'Google Calendar',
    slack: 'Slack',
    stripe: 'Stripe',
    notion: 'Notion',
    hubspot: 'HubSpot',
    shopify: 'Shopify',
    linear: 'Linear',
    github: 'GitHub',
    whatsapp: 'WhatsApp',
    line: 'LINE',
  };
  const key = String(toolkit ?? '').trim().toLowerCase();
  if (known[key]) return known[key];
  // Unknown toolkits are title-cased rather than left lower — the sentence
  // this lands in is shown to a person, and "connect a gmail account" reads
  // like a typo.
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'that';
}
