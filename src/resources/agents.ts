/**
 * Agent Cloud — an agent that runs on Workser's infrastructure, called from
 * this app.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * The app your customer uses is not the machine the agent runs on. An agent
 * needs its own sandbox, its own long-running compute, its own tools and its
 * own memory, and it may work for two hours on one request. None of that fits
 * inside a web request handler.
 *
 * So the shape here is: **start a run, then watch it**. `run()` returns as soon
 * as the work is accepted; `stream()` follows it. That is why the async
 * iterator matters more than any other method in this file — without it, the
 * only way to build a UI that shows an agent thinking is to poll, and a polled
 * agent looks broken to the person waiting on it.
 *
 * ```ts
 * const run = await workser.agents.run(agentId, { message: 'Reconcile March' });
 * for await (const event of workser.agents.stream(run.id)) {
 *   if (event.type === 'message.delta') process.stdout.write(event.data.text);
 * }
 * ```
 *
 * ===========================================================================
 * THE STREAM SURVIVES A DROPPED CONNECTION, AND WHY THAT IS THE WHOLE POINT
 * ===========================================================================
 * A two-hour stream WILL be interrupted — a load balancer idle-timeout, a
 * laptop lid, a redeploy. Core API's SSE endpoint takes an `after_seq` cursor
 * and replays everything past it from the durable event log, so `stream()`
 * reconnects from the last sequence number it actually handed the caller.
 *
 * The caller therefore sees one uninterrupted sequence of events with no
 * duplicates and no gap, and never has to write reconnection logic of their
 * own. An SDK that made every app author rediscover this would be a worse
 * product than no SDK at all.
 */
import type { HttpClient } from '../http.js';
import { WorkserError } from '../errors.js';

/** An agent definition, as the cloud holds it. */
export interface CloudAgent {
  id: string;
  name: string;
  description?: string | null;
  variant?: string;
  project_id?: string;
  is_active?: boolean;
  [key: string]: unknown;
}

export type AgentRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | (string & {});

export interface AgentRun {
  id: string;
  agent_id: string;
  session_id: string;
  status: AgentRunStatus;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: { message?: string; [key: string]: unknown } | null;
  /**
   * What the model cost, in USD. Infrastructure (runtime and workspace
   * minutes) is metered separately and appears on the org's usage, not here —
   * see `AgentRunBillingService` in Core API.
   */
  cost_usd?: number | string;
  cost_credit?: number | string;
  tokens_in?: number;
  tokens_out?: number;
  started_at?: string;
  completed_at?: string;
  created_at?: string;
  [key: string]: unknown;
}

/** One event from a running agent. */
export interface AgentRunEvent {
  /** Monotonic within a run. The cursor a reconnect resumes from. */
  seq: number;
  event_id?: string;
  /** e.g. `run.started`, `step.completed`, `run.completed`. */
  type: string;
  data: Record<string, unknown>;
}

export interface RunOptions {
  /** Override which app this run is attributed to. Defaults to the app the
   *  SDK was constructed in, from `WORKSER_WEB_APP_ID`. */
  webAppId?: string;
  /**
   * WHO this run is for, when the agent serves your app's end users.
   *
   * Required by Core API for PRODUCT-variant agents, and the reason is worth
   * stating: an agent acting on a customer's behalf must be attributable to
   * that customer, or its memory and its audit trail belong to nobody.
   */
  referenceUserId?: string;
  /** Continue an existing conversation instead of starting one. */
  sessionId?: string;
  /** Your own id for the customer's project/tenant, echoed back on the run. */
  referenceProjectId?: string;
  /**
   * Replay protection. Supplied automatically from the input when absent, so a
   * retry after a network timeout resumes the same run instead of starting a
   * second one that does the work twice.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface StreamRunOptions {
  /** Resume from a sequence number you have already handled. */
  afterSeq?: number;
  /** Stop after the run reaches a terminal state. Default true. */
  untilComplete?: boolean;
  /** How many times to transparently reconnect a dropped stream. Default 5. */
  maxReconnects?: number;
  /** Silence after which a connection is considered dead. Default 60s. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Events after which no more will ever arrive. */
const TERMINAL_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** Statuses after which no more events will ever arrive. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export class Agents {
  constructor(
    private readonly http: HttpClient,
    private readonly projectId: string,
    /**
     * This app's own id, when it has one.
     *
     * Sent with every run it starts, so the run's cost is reported against
     * THIS app rather than only against the project. A gateway key is already
     * per-app, so one-shot `workser.ai` calls attribute themselves; agent runs
     * had no equivalent and a project with four apps could see what the
     * project spent and never which app spent it.
     *
     * Undefined outside a Workser-deployed app, and undefined is a real
     * answer — the run is reported as having no app rather than guessed at.
     */
    private readonly webAppId?: string,
  ) {}

  /** The agents this project owns. */
  list(params: { variant?: string; isActive?: boolean } = {}): Promise<CloudAgent[]> {
    return this.http.request<CloudAgent[]>('/v1/agents', {
      query: {
        project_id: this.projectId,
        variant: params.variant,
        is_active: params.isActive,
      },
    });
  }

  get(agentId: string): Promise<CloudAgent> {
    return this.http.request<CloudAgent>(
      `/v1/agents/${encodeURIComponent(agentId)}`,
    );
  }

  /**
   * Give an agent something to do. Returns as soon as the work is accepted —
   * the run itself has almost certainly not finished.
   */
  run(
    agentId: string,
    input: Record<string, unknown>,
    opts: RunOptions = {},
  ): Promise<AgentRun> {
    return this.http.request<AgentRun>(
      `/v1/agents/${encodeURIComponent(agentId)}/runs`,
      {
        method: 'POST',
        body: {
          input,
          reference_user_id: opts.referenceUserId,
          session_id: opts.sessionId,
          reference_project_id: opts.referenceProjectId ?? this.projectId,
          // Attribution, not authorisation — see `webAppId`. Omitted entirely
          // when there is none, so the server stores null rather than a
          // string that looks like an id.
          web_app_id: opts.webAppId ?? this.webAppId,
        },
        // Starting an agent run spends real money and may send real email, so
        // an automatic transport-level retry after a timeout must NOT be able
        // to start a second one. Core API dedupes on this key.
        idempotencyKey: opts.idempotencyKey ?? freshIdempotencyKey(),
        signal: opts.signal,
      },
    );
  }

  /** Recent runs, newest first. */
  listRuns(
    params: {
      agentId?: string;
      sessionId?: string;
      referenceUserId?: string;
      status?: string;
      limit?: number;
    } = {},
  ): Promise<AgentRun[]> {
    return this.http.request<AgentRun[]>('/v1/runs', {
      query: {
        agent_id: params.agentId,
        session_id: params.sessionId,
        reference_user_id: params.referenceUserId,
        status: params.status,
        limit: params.limit,
      },
    });
  }

  /** One run, with its steps, messages and artifacts. */
  getRun(runId: string): Promise<AgentRun> {
    return this.http.request<AgentRun>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(runId: string): Promise<AgentRun> {
    return this.http.request<AgentRun>(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', body: {} },
    );
  }

  /**
   * Watch a run, event by event, reconnecting through interruptions.
   *
   * The reconnect is the substance of this method. Every yielded event
   * advances a cursor; a dropped connection reopens at that cursor, so the
   * caller's sequence has no gap and no repeat regardless of how the network
   * behaved underneath. A stream that has been interrupted more than
   * `maxReconnects` times throws the underlying error rather than silently
   * ending — an agent whose output stopped arriving must never look to the
   * caller like an agent that finished.
   */
  async *stream(
    runId: string,
    opts: StreamRunOptions = {},
  ): AsyncGenerator<AgentRunEvent> {
    const maxReconnects = opts.maxReconnects ?? 5;
    const untilComplete = opts.untilComplete ?? true;
    let cursor = opts.afterSeq ?? 0;
    let reconnects = 0;

    for (;;) {
      let sawTerminal = false;
      try {
        const frames = this.http.stream(
          `/v1/runs/${encodeURIComponent(runId)}/events`,
          {
            query: { after_seq: cursor },
            idleTimeoutMs: opts.idleTimeoutMs,
            signal: opts.signal,
          },
        );

        for await (const frame of frames) {
          // The server's own keep-alive. It exists to reset the idle clock,
          // which it already did by arriving; it is not part of the run.
          if (frame.event === 'heartbeat') continue;

          const event = decodeEvent(frame.event, frame.id, frame.data);
          if (!event) continue;

          // Advance the cursor BEFORE yielding. If the consumer's loop throws
          // or breaks, the run is left at the last event we actually handed
          // over — resuming from there is correct either way.
          if (event.seq > cursor) cursor = event.seq;
          yield event;

          if (TERMINAL_EVENTS.has(event.type)) {
            sawTerminal = true;
            if (untilComplete) return;
          }
        }
      } catch (error) {
        const retryable =
          error instanceof WorkserError && error.retryable === true;
        if (!retryable || reconnects >= maxReconnects || opts.signal?.aborted) {
          throw error;
        }
        reconnects++;
        await sleep(Math.min(500 * 2 ** reconnects, 8_000));
        continue;
      }

      // The connection closed cleanly without a terminal event. That happens
      // when Core API's in-process fan-out for this run went away — a redeploy
      // between the run starting and us connecting, most often. The run itself
      // may be finished, running, or gone, and only the run row knows which.
      if (sawTerminal || !untilComplete) return;

      const run = await this.getRun(runId).catch(() => null);
      if (run && TERMINAL_STATUSES.has(String(run.status))) return;
      if (reconnects >= maxReconnects) {
        throw new WorkserError(
          `The event stream for run ${runId} closed ${reconnects + 1} times ` +
            'without the run finishing. Read the run directly with ' +
            '`agents.getRun()` to see where it got to.',
          { code: 'network', retryable: false },
        );
      }
      reconnects++;
      await sleep(Math.min(500 * 2 ** reconnects, 8_000));
    }
  }

  /**
   * Start a run and wait for it, optionally reporting progress.
   *
   * The one-call path for a backend job that has nowhere to stream TO. It is
   * built on `stream()` rather than on polling so that "waiting" costs one
   * connection instead of a request every second — and so `onEvent` can drive
   * a progress log without the caller wiring the iterator up themselves.
   */
  async runAndWait(
    agentId: string,
    input: Record<string, unknown>,
    opts: RunOptions & {
      onEvent?: (event: AgentRunEvent) => void;
      idleTimeoutMs?: number;
    } = {},
  ): Promise<AgentRun> {
    const started = await this.run(agentId, input, opts);
    for await (const event of this.stream(started.id, {
      idleTimeoutMs: opts.idleTimeoutMs,
      signal: opts.signal,
    })) {
      opts.onEvent?.(event);
    }
    // Re-read rather than trusting the terminal event's payload: the run row
    // is the record, and it carries the output, the error and the cost.
    return this.getRun(started.id);
  }
}

/**
 * Decode one SSE frame into a run event.
 *
 * Tolerant on purpose. A frame the SDK cannot parse is dropped rather than
 * thrown, because one malformed event must not take down a two-hour stream —
 * and a server that adds a field later must not break a client shipped today.
 */
function decodeEvent(
  eventName: string,
  id: string | undefined,
  data: string,
): AgentRunEvent | null {
  let parsed: Record<string, unknown> = {};
  if (data) {
    try {
      const value = JSON.parse(data);
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const seq = Number(parsed.seq ?? id);
  if (!Number.isFinite(seq)) return null;

  return {
    seq,
    event_id: typeof parsed.event_id === 'string' ? parsed.event_id : undefined,
    type: (typeof parsed.type === 'string' ? parsed.type : eventName) || 'message',
    data: (parsed.data as Record<string, unknown>) ?? {},
  };
}

/**
 * A fresh key for one logical invocation.
 *
 * RANDOM, not derived from the input, and the distinction is the whole point.
 * The key is built once and reused across `request()`'s internal retries, so a
 * POST that times out and is retried resolves to the SAME run — which is what
 * an idempotency key is for. Deriving it from the input instead would ALSO
 * collapse two deliberate, identical requests ("check inventory", twice) into
 * one run, and silently returning yesterday's answer to today's question is a
 * worse failure than the double-run it was meant to prevent.
 *
 * Callers whose dedupe rule is genuinely about content — one run per customer
 * order, say — pass `idempotencyKey` themselves.
 */
function freshIdempotencyKey(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    ?.randomUUID;
  if (typeof uuid === 'function') return `run_${uuid.call(globalThis.crypto)}`;
  // Node 18 without the global, and any runtime that trims `crypto`.
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
