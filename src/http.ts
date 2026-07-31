/**
 * The single HTTP path.
 *
 * Every call in the SDK goes through here, so auth, timeouts, retries,
 * idempotency and error shaping exist in exactly one place and cannot drift
 * between resources.
 */
import type { ResolvedConfig } from './config.js';
import { WorkserError, classifyStatus, type WorkserRequestInfo } from './errors.js';
import { redact } from './redact.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** `bearer` → Authorization (business/composio); `cloud` → x-api-key. */
  auth?: 'bearer' | 'cloud' | 'none';
  /** Override the base URL — used by the workflow service. */
  baseUrl?: string;
  /** Override the bearer token — used by the workflow service. */
  token?: string;
  /**
   * Per-request headers, merged over the client's.
   *
   * Needed because not every Workser service authenticates the same way: the
   * workflow service reads `x-api-key`, not `Authorization`. Without this the
   * workflow namespace silently sent no credential at all and every trigger
   * came back 401.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Replay protection for writes. Sent as `Idempotency-Key`. Supplied
   * automatically for retryable writes so a retry after a timeout cannot
   * create a second order.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Terminal-ish statuses we never retry regardless of method. */
function shouldRetry(status: number | undefined, retryable: boolean, attempt: number, max: number): boolean {
  if (attempt >= max) return false;
  if (status === undefined) return true; // network error — the request never landed
  return retryable;
}

/** Full jitter backoff — avoids a fleet of agents retrying in lockstep. */
function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  const ceiling = Math.min(1000 * 2 ** attempt, 8000);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpClient {
  constructor(private readonly config: ResolvedConfig) {}

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const base = opts.baseUrl ?? this.config.baseUrl;
    const url = new URL(base + path);

    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': `workser-sdk/${SDK_VERSION}`,
      ...this.config.headers,
      ...opts.headers,
    };

    const auth = opts.auth ?? 'bearer';
    if (auth === 'bearer') {
      const token = opts.token ?? this.config.apiKey;
      if (!token) {
        throw new WorkserError(
          'No Workser API key. Workser injects WORKSER_BUSINESS_API_KEY into ' +
            'your app automatically — pass `new Workser({ apiKey })` if you are ' +
            'running outside a Workser-provisioned environment.',
          { code: 'config' },
        );
      }
      headers.authorization = `Bearer ${token}`;
    } else if (auth === 'cloud') {
      if (!this.config.cloudApiKey) {
        throw new WorkserError(
          'No Workser cloud key. Storage, auth and database routes need ' +
            'WORKSER_CORE_API_SERVICE_API_KEY.',
          { code: 'config' },
        );
      }
      headers['x-api-key'] = this.config.cloudApiKey;
    }

    if (this.config.organizationId) {
      headers['x-organization-id'] = this.config.organizationId;
    }

    const isWrite = method !== 'GET';
    if (isWrite && opts.idempotencyKey) {
      headers['idempotency-key'] = opts.idempotencyKey;
    }

    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    const info: WorkserRequestInfo = { method, path };
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
    let lastError: WorkserError | undefined;

    for (let attempt = 0; ; attempt++) {
      // A fresh controller per attempt — an aborted one stays aborted.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = opts.signal
        ? anySignal([opts.signal, controller.signal])
        : controller.signal;

      let res: Response;
      try {
        res = await this.config.fetch(url, {
          method,
          headers,
          body: payload,
          signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const aborted = opts.signal?.aborted === true;
        if (aborted) {
          throw new WorkserError('Request cancelled.', {
            code: 'timeout',
            request: info,
            cause: err,
          });
        }
        const timedOut = controller.signal.aborted;
        lastError = new WorkserError(
          timedOut
            ? `Request timed out after ${timeoutMs}ms.`
            : 'Could not reach Workser.',
          {
            code: timedOut ? 'timeout' : 'network',
            request: info,
            retryable: true,
            cause: err,
          },
        );
        if (shouldRetry(undefined, true, attempt, this.config.maxRetries)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      const requestId =
        res.headers.get('x-request-id') ?? res.headers.get('x-correlation-id') ?? undefined;
      const attemptInfo: WorkserRequestInfo = { ...info, status: res.status, requestId };

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          const parsed = JSON.parse(text);
          // Core API wraps some responses as `{ data }`; unwrap so callers get
          // the resource either way rather than having to know which did.
          return unwrap(parsed) as T;
        } catch {
          return text as unknown as T;
        }
      }

      const bodyText = await res.text().catch(() => '');
      const details = safeJson(bodyText);
      const { code, retryable } = classifyStatus(res.status);

      lastError = new WorkserError(redact(messageFor(code, details, bodyText)), {
        code,
        status: res.status,
        request: attemptInfo,
        details,
        retryable,
      });

      if (shouldRetry(res.status, retryable, attempt, this.config.maxRetries)) {
        const retryAfter = Number(res.headers.get('retry-after')) || undefined;
        await sleep(backoffMs(attempt, retryAfter));
        continue;
      }
      throw lastError;
    }
  }
}

/** `{ data: X }` → `X`; anything else untouched. */
function unwrap(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'data' in (parsed as Record<string, unknown>) &&
    Object.keys(parsed as Record<string, unknown>).every((k) =>
      ['data', 'ok', 'success', 'meta', 'pagination'].includes(k),
    )
  ) {
    return (parsed as Record<string, unknown>).data;
  }
  return parsed;
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageFor(code: string, details: unknown, raw: string): string {
  const d = details as
    | { message?: string | string[]; error?: string | { message?: string } }
    | undefined;
  const fromBody =
    (Array.isArray(d?.message) ? d?.message.join(', ') : d?.message) ??
    (typeof d?.error === 'string' ? d.error : d?.error?.message);
  if (fromBody) return fromBody;

  switch (code) {
    case 'unauthorized':
      return 'Workser rejected the API key. It may be revoked or for another project.';
    case 'forbidden':
      return 'This API key lacks the scope required for that call.';
    case 'not_found':
      return 'Not found.';
    case 'rate_limited':
      return 'Rate limited by Workser.';
    case 'server_error':
      return 'Workser returned a server error.';
    default:
      return raw ? raw.slice(0, 300) : 'Request failed.';
  }
}

/** Combine abort signals without requiring `AbortSignal.any` (Node 20+ only). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal })
    .any;
  if (typeof anyFn === 'function') return anyFn(signals);

  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** Injected at build time; falls back for source usage. */
declare const __SDK_VERSION__: string;
export const SDK_VERSION =
  typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.1.0';
