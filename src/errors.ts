/**
 * Typed errors.
 *
 * Every failure the SDK surfaces is one of these, so calling code can branch on
 * a stable `code` instead of matching message strings that will change.
 *
 * SECURITY: none of these ever carry a credential. `WorkserError.request`
 * records the method, path and status — never headers, never the body of an
 * authenticated request. An error object routinely ends up in a log
 * aggregator, a Sentry event, or an LLM's context window, and a key that
 * reaches any of those is a key that has to be rotated.
 */

export type WorkserErrorCode =
  | 'config' // the SDK was constructed wrong (missing project id, key, …)
  | 'unauthorized' // 401 — key missing, malformed, or revoked
  | 'forbidden' // 403 — key is valid but lacks the scope for this call
  | 'not_found' // 404
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'invalid_request' // 4xx we did not classify
  | 'server_error' // 5xx
  | 'timeout' // the request exceeded `timeoutMs`
  | 'network' // DNS/TLS/socket — the request never got a response
  // 402 — the organisation's credit ledger is empty. Named separately from
  // `forbidden` because it is the one refusal in this list the app's OWNER can
  // fix, in a minute, by topping up. Telling them "forbidden" sends them
  // looking for a permissions problem that does not exist.
  | 'insufficient_credit'
  | 'http' // a status this SDK does not classify further
  | 'unsupported'; // the runtime cannot do this safely (see BrowserSecretError)

export interface WorkserRequestInfo {
  method: string;
  /** Path only — never the full URL with a query string that may carry ids. */
  path: string;
  status?: number;
  /** Server-provided correlation id, when present. Safe to log and to quote. */
  requestId?: string;
}

export class WorkserError extends Error {
  readonly code: WorkserErrorCode;
  readonly status?: number;
  readonly request?: WorkserRequestInfo;
  /** Parsed error body, if the server sent one. Never contains credentials. */
  readonly details?: unknown;
  /** True when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      code: WorkserErrorCode;
      status?: number;
      request?: WorkserRequestInfo;
      details?: unknown;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'WorkserError';
    this.code = opts.code;
    this.status = opts.status;
    this.request = opts.request;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /**
   * A one-line, safe-to-log summary.
   *
   * Deliberately not `toString()` — overriding that makes it too easy for
   * `${err}` somewhere to start emitting something we later extend.
   */
  summary(): string {
    const where = this.request
      ? ` (${this.request.method} ${this.request.path}${
          this.request.status ? ` → ${this.request.status}` : ''
        })`
      : '';
    const rid = this.request?.requestId ? ` [request ${this.request.requestId}]` : '';
    return `${this.code}: ${this.message}${where}${rid}`;
  }
}

/**
 * Raised when a secret key would be used from a browser.
 *
 * A Workser API key is a bearer credential for an entire project's business
 * data, connected accounts and storage. Shipping one to a browser publishes it
 * to every visitor — bundlers inline `process.env`, and "it's only in a private
 * beta" has never once prevented this. The SDK refuses rather than trusting the
 * caller to have thought it through.
 *
 * Call Workser from your server (route handler, server action, edge function)
 * and let the browser talk to your server.
 */
export class BrowserSecretError extends WorkserError {
  constructor() {
    super(
      'Refusing to use a Workser API key in client-side code (browser or ' +
        'React Native). This key grants access to your project\'s business ' +
        'data, connected accounts and storage — shipped to a client it is ' +
        'readable by every user, and in a mobile binary it cannot be rotated ' +
        'without an app-store release. Call Workser from your own backend and ' +
        'let the client talk to that.',
      { code: 'unsupported' },
    );
    this.name = 'BrowserSecretError';
  }
}

/** Map an HTTP status onto a stable code + whether a retry could help. */
export function classifyStatus(status: number): {
  code: WorkserErrorCode;
  retryable: boolean;
} {
  if (status === 401) return { code: 'unauthorized', retryable: false };
  if (status === 403) return { code: 'forbidden', retryable: false };
  if (status === 404) return { code: 'not_found', retryable: false };
  if (status === 409) return { code: 'conflict', retryable: false };
  // 429 and 408 are the two 4xx where the same request may later succeed.
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status >= 500) return { code: 'server_error', retryable: true };
  return { code: 'invalid_request', retryable: false };
}
