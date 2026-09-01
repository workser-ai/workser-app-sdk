/**
 * Server-sent events — the SDK's only long-lived connection.
 *
 * ===========================================================================
 * WHY THIS IS NOT `request()` WITH A DIFFERENT ACCEPT HEADER
 * ===========================================================================
 * `HttpClient.request` is built for calls that finish: it buffers the whole
 * body, and it aborts the request after `timeoutMs` no matter what. Both are
 * right for a REST call and fatal for a stream. An agent run may legitimately
 * work for two hours, so a total timeout would guarantee that every long run
 * — the ones somebody most wants to watch — dies mid-flight at the 30-second
 * mark with no error the caller could act on.
 *
 * So streams get their own path with two different rules:
 *
 *   • **An IDLE timeout, not a total one.** The clock resets on every byte
 *     that arrives. A stream that is producing output is healthy however long
 *     it runs; a stream that has gone quiet for minutes is not. Core API sends
 *     a `heartbeat` frame every 15s precisely so a quiet-but-alive run keeps
 *     resetting this — see `RunEventsService`.
 *
 *   • **No blind retry.** `request()` may replay a whole call safely because
 *     nothing was delivered. Half a stream HAS been delivered, so replaying it
 *     from the start would hand the caller duplicate events. Resuming is a
 *     decision only the caller's resource can make, because only it knows what
 *     the cursor means. `Agents.stream` does it with `after_seq`.
 *
 * ===========================================================================
 * PARSING
 * ===========================================================================
 * Hand-rolled rather than pulled from a dependency, because the SDK ships with
 * none and this is the whole of the wire format: `field: value` lines, a blank
 * line dispatches the accumulated event, `data:` accumulates across lines
 * joined by newline, and a leading space after the colon is stripped. Fields
 * we do not use are ignored rather than treated as an error, which is what the
 * spec requires and what keeps a future server-side field from breaking old
 * clients.
 */
import { WorkserError, type WorkserRequestInfo } from './errors.js';

/** One dispatched SSE frame. */
export interface SseEvent {
  /** The `id:` field. Core API sends the event's sequence number. */
  id?: string;
  /** The `event:` field. Defaults to `message`, as the spec requires. */
  event: string;
  /** The `data:` field(s), joined by newline. */
  data: string;
}

export interface StreamOptions {
  /**
   * How long a stream may produce NOTHING before it is considered dead.
   *
   * Defaults to 60s: four missed 15-second heartbeats. One missed heartbeat is
   * a hiccup, four in a row is a connection that is not coming back.
   */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
}

/**
 * Turn a `ReadableStream` of bytes into dispatched SSE events.
 *
 * Split out from the fetching so it can be tested against a literal wire
 * transcript — including the two cases that break naive parsers: a frame split
 * across chunk boundaries, and a multi-line `data:` field.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      // A frame ends at a blank line. Normalise CRLF first so a server that
      // uses it does not leave a stray \r on the last data line.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    // A server that closes without a trailing blank line still meant to send
    // whatever it had. Dropping it would lose the terminal frame — which is
    // the single most important one in a run.
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    // Releasing matters even on an early `break` out of the caller's loop:
    // an un-cancelled reader holds the socket open until GC.
    reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
}

function parseFrame(frame: string): SseEvent | null {
  if (!frame.trim()) return null;

  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];

  for (const rawLine of frame.split('\n')) {
    // A line starting with `:` is a comment — some proxies inject them as
    // keep-alives. It is activity, not an event.
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // `retry` and anything unknown: ignored on purpose.
  }

  if (!data.length && id === undefined && event === undefined) return null;
  return { id, event: event ?? 'message', data: data.join('\n') };
}

/**
 * Open one SSE connection and yield its frames.
 *
 * Throws before yielding anything if the connection itself fails, so a caller
 * can tell "never connected" (retryable, nothing delivered) apart from "died
 * mid-stream" (resume from the cursor, do not replay).
 */
export async function* openSseStream(params: {
  url: URL;
  headers: Record<string, string>;
  fetch: typeof globalThis.fetch;
  idleTimeoutMs: number;
  signal?: AbortSignal;
  request: WorkserRequestInfo;
}): AsyncGenerator<SseEvent> {
  const controller = new AbortController();
  const signal = params.signal
    ? anySignal([params.signal, controller.signal])
    : controller.signal;

  // The idle clock. `bump()` is called on connect and on every chunk, so the
  // deadline always measures silence rather than total duration.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle = false;
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      controller.abort();
    }, params.idleTimeoutMs);
  };

  let res: Response;
  bump();
  try {
    res = await params.fetch(params.url, {
      method: 'GET',
      headers: { ...params.headers, accept: 'text/event-stream' },
      signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (params.signal?.aborted) {
      throw new WorkserError('Stream cancelled.', {
        code: 'timeout',
        request: params.request,
        cause: err,
      });
    }
    throw new WorkserError('Could not open the stream.', {
      code: 'network',
      request: params.request,
      retryable: true,
      cause: err,
    });
  }

  if (!res.ok || !res.body) {
    if (timer) clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new WorkserError(
      text?.slice(0, 300) || `Stream failed with status ${res.status}.`,
      {
        code: res.status >= 500 ? 'server_error' : 'invalid_request',
        status: res.status,
        request: { ...params.request, status: res.status },
        // 5xx never connected either, so replaying it delivers nothing twice.
        retryable: res.status >= 500 || res.status === 429,
      },
    );
  }

  try {
    for await (const event of parseSse(res.body, bump)) {
      yield event;
    }
  } catch (err) {
    if (idle) {
      throw new WorkserError(
        `The stream sent nothing for ${params.idleTimeoutMs}ms and was closed.`,
        { code: 'timeout', request: params.request, retryable: true, cause: err },
      );
    }
    if (params.signal?.aborted) {
      throw new WorkserError('Stream cancelled.', {
        code: 'timeout',
        request: params.request,
        cause: err,
      });
    }
    throw new WorkserError('The stream ended unexpectedly.', {
      code: 'network',
      request: params.request,
      retryable: true,
      cause: err,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Duplicated from `http.ts` for the same reason it exists there: `AbortSignal.any` is Node 20+. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
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
