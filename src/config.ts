/**
 * Configuration resolution.
 *
 * The design goal is that a generated app needs **no configuration at all**.
 * Workser provisions a project's credentials into its environment (see
 * `project_envs`), so `new Workser()` with no arguments is the intended path
 * and everything below is an override for people running outside that.
 */
import { BrowserSecretError, WorkserError } from './errors.js';

export interface WorkserConfig {
  /** Project these calls act on. Defaults to `WORKSER_PROJECT_ID`. */
  projectId?: string;
  /** Bearer key. Defaults to `WORKSER_BUSINESS_API_KEY` then `WORKSER_API_KEY`. */
  apiKey?: string;
  /** Core API base. Defaults to `WORKSER_CORE_API_SERVICE_BASE_URL`. */
  baseUrl?: string;
  /** Organization id, sent as `x-organization-id` when known. */
  organizationId?: string;
  /** Workflow service base. Defaults to `WORKFLOW_BASE_URL`. */
  workflowBaseUrl?: string;
  /** Workflow service key. Defaults to `WORKFLOW_API_KEY`. */
  workflowApiKey?: string;
  /**
   * Cloud key for infrastructure routes (storage/auth/database), sent as
   * `x-api-key`. Defaults to `WORKSER_CORE_API_SERVICE_API_KEY`.
   *
   * Separate from `apiKey` today because the business key and the cloud key
   * carry different scope families. One unified key is planned; until then the
   * SDK holds both so callers never have to think about which is which.
   */
  cloudApiKey?: string;
  /**
   * Where one-shot model calls go — `workser.ai.*`. Defaults to
   * `WORKSER_AI_GATEWAY_URL`, which Workser injects at provisioning.
   *
   * A DIFFERENT SERVICE from `baseUrl`, deliberately. Core API is the
   * management plane; the AI gateway is a metered proxy in front of the model
   * routers, with its own per-app credential that can be rotated without
   * touching anything else the app can reach.
   */
  aiGatewayUrl?: string;
  /** Key for `aiGatewayUrl`. Defaults to `AI_GATEWAY_API_KEY`. */
  aiGatewayApiKey?: string;
  /**
   * This app's own id, so the runs it starts are reported against it.
   *
   * Defaults to `WORKSER_WEB_APP_ID`, which Workser injects at provisioning.
   * Absent outside a Workser-deployed app, and absent is a real answer: a run
   * with no app behind it is reported as exactly that rather than guessed at.
   */
  webAppId?: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** Retries for retryable failures (5xx, 429, network). Default 2. */
  maxRetries?: number;
  /**
   * Permit construction in a browser with a secret key. Off by default and
   * you almost certainly want it to stay off — see `BrowserSecretError`.
   */
  allowBrowser?: boolean;
  /** Injected for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. Never use this to pass credentials. */
  headers?: Record<string, string>;
}

export interface ResolvedConfig {
  projectId: string;
  apiKey?: string;
  baseUrl: string;
  organizationId?: string;
  workflowBaseUrl?: string;
  workflowApiKey?: string;
  cloudApiKey?: string;
  aiGatewayUrl?: string;
  aiGatewayApiKey?: string;
  webAppId?: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: typeof globalThis.fetch;
  headers: Record<string, string>;
}

const DEFAULT_BASE_URL = 'https://api.workser.ai';

function env(name: string): string | undefined {
  // `process` is absent in browsers/edge; guard rather than assume Node.
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const v = p?.env?.[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Are we somewhere the user can read the key?
 *
 * Two distinct environments, and missing either one leaks a project key:
 *
 *  • **Browser** — detected via `window.document` rather than just `window`,
 *    because some server runtimes (jsdom under test, certain edge shims)
 *    define a partial `window` while being perfectly safe places to hold a key.
 *
 *  • **React Native** — has NO `window.document`, so a browser-only check
 *    sails straight past it. A key compiled into a mobile binary is arguably
 *    worse than one in a browser bundle: it ships to an app store, cannot be
 *    rotated without a release, and is trivially recovered from the IPA/APK.
 *    Mobile apps must call their own backend, never Workser directly.
 */
export function isClientRuntime(): boolean {
  const g = globalThis as {
    window?: { document?: unknown };
    navigator?: { product?: string };
  };
  if (typeof g.window !== 'undefined' && typeof g.window?.document !== 'undefined') {
    return true;
  }
  return g.navigator?.product === 'ReactNative';
}

/** @deprecated Use `isClientRuntime` — it also covers React Native. */
export const isBrowser = isClientRuntime;

export function resolveConfig(config: WorkserConfig = {}): ResolvedConfig {
  const apiKey = config.apiKey ?? env('WORKSER_BUSINESS_API_KEY') ?? env('WORKSER_API_KEY');

  if (apiKey && isClientRuntime() && !config.allowBrowser) {
    throw new BrowserSecretError();
  }

  const projectId = config.projectId ?? env('WORKSER_PROJECT_ID');
  if (!projectId) {
    throw new WorkserError(
      'No Workser project id. Workser injects WORKSER_PROJECT_ID into your ' +
        'app automatically — if you are running outside a Workser-provisioned ' +
        'environment, pass `new Workser({ projectId })`.',
      { code: 'config' },
    );
  }

  const baseUrl = (
    config.baseUrl ??
    env('WORKSER_CORE_API_SERVICE_BASE_URL') ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  // A credential must only ever travel to an https origin. Loopback is exempt
  // so local development against a dev API still works.
  assertSafeBaseUrl(baseUrl);

  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxRetries = config.maxRetries ?? 2;
  if (timeoutMs <= 0) {
    throw new WorkserError('timeoutMs must be greater than 0.', { code: 'config' });
  }
  if (maxRetries < 0) {
    throw new WorkserError('maxRetries cannot be negative.', { code: 'config' });
  }

  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new WorkserError(
      'No global fetch available. Use Node 18+, or pass `{ fetch }`.',
      { code: 'config' },
    );
  }

  return {
    projectId,
    apiKey,
    baseUrl,
    organizationId: config.organizationId ?? env('WORKSER_ORGANIZATION_ID'),
    workflowBaseUrl: (config.workflowBaseUrl ?? env('WORKFLOW_BASE_URL'))?.replace(
      /\/+$/,
      '',
    ),
    workflowApiKey: config.workflowApiKey ?? env('WORKFLOW_API_KEY'),
    cloudApiKey: config.cloudApiKey ?? env('WORKSER_CORE_API_SERVICE_API_KEY'),
    aiGatewayUrl: (config.aiGatewayUrl ?? env('WORKSER_AI_GATEWAY_URL'))?.replace(
      /\/+$/,
      '',
    ),
    aiGatewayApiKey: config.aiGatewayApiKey ?? env('AI_GATEWAY_API_KEY'),
    webAppId: config.webAppId ?? env('WORKSER_WEB_APP_ID'),
    timeoutMs,
    maxRetries,
    fetch: doFetch.bind(globalThis),
    headers: config.headers ?? {},
  };
}

/**
 * Refuse to send credentials over plaintext to a remote host.
 *
 * A misconfigured `baseUrl` is the most boring possible way to leak a project
 * key onto the wire, and it is entirely preventable here.
 */
function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkserError(`Invalid base URL: ${baseUrl}`, { code: 'config' });
  }

  if (url.protocol === 'https:') return;

  const host = url.hostname;
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol === 'http:' && isLoopback) return;

  throw new WorkserError(
    `Refusing to send a Workser API key to ${url.protocol}//${host} over ` +
      'plaintext. Use https, or point at localhost for local development.',
    { code: 'config' },
  );
}
