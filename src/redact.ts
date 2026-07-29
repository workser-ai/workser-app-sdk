/**
 * Credential redaction.
 *
 * The SDK is used by AI agents. Anything it returns or throws can end up in a
 * model's context window, a transcript, a support ticket, or a log — so a
 * credential appearing in any string the SDK produces should be treated as
 * disclosed, not "probably fine".
 *
 * This is defence in depth. The primary rule is that we never put a key
 * anywhere but the `Authorization` header in the first place; this catches the
 * case where a key reaches a message some other way — a caller interpolating
 * one into a path, a server echoing a header back in an error body.
 */

/**
 * Workser and common third-party key shapes.
 *
 * Ordered longest-prefix-first so `wsr_run_` is masked as a unit rather than
 * leaving `run_…` visible after `wsr_` is consumed.
 */
const KEY_PATTERNS: RegExp[] = [
  /\bwsr_run_[A-Za-z0-9_-]{6,}/g, // Workser runner key
  /\bwsr_[A-Za-z0-9_-]{6,}/g, // Workser key
  /\bwks_[A-Za-z0-9_-]{6,}/g, // Workser cloud key
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI-style
  /\bsk_live_[A-Za-z0-9]{6,}/g, // Stripe live
  /\bsk_test_[A-Za-z0-9]{6,}/g, // Stripe test
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // any bearer token
];

/** Postgres/MySQL/Mongo URIs — mask the password, keep the shape readable. */
const CONNECTION_URI = /\b([a-z+]+:\/\/[^:/@\s]+):([^@\s]+)@/gi;

/**
 * Mask credentials in a string.
 *
 * Keeps a short prefix so a human can still tell *which* key was involved
 * ("the wsr_run_ one, not the cloud one") without the value being usable.
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;

  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, (match) => mask(match));
  }
  out = out.replace(CONNECTION_URI, (_m, scheme: string) => `${scheme}:***@`);

  return out;
}

/**
 * Known credential prefixes, longest first.
 *
 * Keeping the PREFIX rather than "the first N characters" is deliberate: a
 * length-based rule truncated `wsr_run_…` to `wsr_`, which is exactly the
 * distinction someone reading a log needs — a runner key and a cloud key
 * failing look identical without it. The prefix carries no secret entropy.
 */
const KEY_PREFIXES = [
  'wsr_run_',
  'sk_live_',
  'sk_test_',
  'wsr_',
  'wks_',
  'ghp_',
  'sk-',
];

function mask(secret: string): string {
  const prefix = KEY_PREFIXES.find((p) => secret.startsWith(p));
  if (prefix) return `${prefix}…redacted`;

  // Unrecognised shape (a bearer token, say). Keep a short head so two
  // different tokens are still distinguishable in a log, but never enough to
  // be a meaningful head start against a >=32-character secret.
  const keep = Math.min(6, Math.max(3, Math.floor(secret.length / 8)));
  return `${secret.slice(0, keep)}…redacted`;
}

/**
 * Deep-redact a value for logging.
 *
 * Strings are masked; objects are walked. Keys whose NAME suggests a secret are
 * dropped entirely rather than masked — a field called `password` should not
 * even reveal its length.
 */
const SECRET_KEY_NAMES =
  /^(authorization|api[-_]?key|secret|password|passwd|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|connection[-_]?uri|database[-_]?url)$/i;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_NAMES.test(k) ? '[redacted]' : redactValue(v, depth + 1);
  }
  return out;
}
