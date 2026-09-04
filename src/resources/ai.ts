/**
 * One call, one answer — a model, without an agent.
 *
 * ===========================================================================
 * WHY THIS EXISTS BESIDE `workser.agents`
 * ===========================================================================
 * `workser.agents.run()` starts a sandboxed agent: its own machine, its own
 * tools, its own memory, minutes of metered runtime, possibly hours of work.
 * That is right for "reconcile March" and wrong for "write a product
 * description", "draw a thumbnail for this listing", "read out this
 * confirmation", "what is this photo of".
 *
 * Until now it was the only route to a model from an app Workser hosts, so
 * every one-shot generation paid agent-shaped money — a sandbox boot and a
 * tool loop — for a call that takes a second. The metered gateway itself only
 * ever relayed `chat/completions`, which is also why an app could not make a
 * picture at all.
 *
 * THE RULE, short enough to remember:
 *
 *   **One answer → `workser.ai`. Work that takes minutes and uses tools →
 *   `workser.agents`.**
 *
 * ===========================================================================
 * THE SAME WALLET, THE SAME BILL
 * ===========================================================================
 * Both go through Workser's own key and settle to the same organisation
 * credit ledger, at the real upstream cost plus Workser's fee. Nobody holds a
 * provider key, and nothing here is free — an app that loops over a thousand
 * listings generating images will see it on the same invoice as everything
 * else.
 *
 * ===========================================================================
 * OPENAI-SHAPED ON PURPOSE
 * ===========================================================================
 * The gateway is an OpenAI-compatible proxy, so `options` on every method is
 * passed through untouched. Anything a provider supports that this file has
 * not thought of — a seed, a response format, a provider-specific knob — works
 * without an SDK release. A typed wrapper that whitelisted fields would turn
 * every new provider feature into a version bump.
 */
import { WorkserError } from '../errors.js';
import type { ResolvedConfig } from '../config.js';

export interface AiCallOptions {
  /** Anything else the provider takes. Merged into the request body. */
  [key: string]: unknown;
}

export interface TextResult {
  /** The reply, already unwrapped from the choices array. */
  text: string;
  model: string;
  /** The whole upstream body, for anything this shape does not carry. */
  raw: any;
}

export interface ImageResult {
  /** Public URLs when the provider returns links, empty when it returns
   *  base64 — check `b64` in that case. Providers differ and neither is
   *  wrong, so both are surfaced rather than one being invented. */
  urls: string[];
  b64: string[];
  raw: any;
}

export interface EmbedResult {
  /** One vector per input, in the order they were given. */
  vectors: number[][];
  raw: any;
}

/**
 * Model calls that return in one round trip.
 *
 * Reachable only from a Workser-provisioned environment, or one where
 * `WORKSER_AI_GATEWAY_URL` and `AI_GATEWAY_API_KEY` are set — the same two
 * variables Workser injects into every app it deploys.
 */
export class Ai {
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether model calls are available at all, without throwing to find out. */
  get available(): boolean {
    return Boolean(this.config.aiGatewayUrl && this.config.aiGatewayApiKey);
  }

  /**
   * Ask a model something and get the text back.
   *
   * `prompt` is a string because that is what almost every call is. Pass
   * `messages` through `options` for a real conversation — it overrides the
   * single-message body this builds.
   */
  async text(
    prompt: string,
    options: AiCallOptions & { model?: string; system?: string } = {},
  ): Promise<TextResult> {
    const { model, system, ...rest } = options;
    const body: Record<string, unknown> = {
      model: model ?? DEFAULT_TEXT_MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      ...rest,
    };
    const data = await this.post('chat/completions', body);
    return {
      text: data?.choices?.[0]?.message?.content ?? '',
      model: data?.model ?? String(body.model),
      raw: data,
    };
  }

  /**
   * Stream a reply token by token.
   *
   * Yields text deltas, not raw SSE frames — an app rendering a reply wants
   * the words, and every caller that got frames would write the same parser.
   * The underlying body is still OpenAI-shaped, so `options` reaches the
   * provider untouched.
   */
  async *stream(
    prompt: string,
    options: AiCallOptions & { model?: string; system?: string } = {},
  ): AsyncGenerator<string> {
    const { model, system, ...rest } = options;
    const response = await this.request('chat/completions', {
      model: model ?? DEFAULT_TEXT_MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      stream: true,
      ...rest,
    });

    const body = response.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line, and a chunk boundary lands
      // in the middle of one often enough that anything simpler drops tokens.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) yield delta;
          } catch {
            // A partial or non-JSON frame is not worth failing a stream over.
          }
        }
      }
    }
  }

  /** Draw a picture. Returns URLs when the provider gives them, base64 when
   *  it does not — see `ImageResult`. */
  async image(
    prompt: string,
    options: AiCallOptions & { model?: string } = {},
  ): Promise<ImageResult> {
    const { model, ...rest } = options;
    const data = await this.post('images/generations', {
      model: model ?? DEFAULT_IMAGE_MODEL,
      prompt,
      ...rest,
    });
    const items: any[] = Array.isArray(data?.data) ? data.data : [];
    return {
      urls: items.map((i) => i?.url).filter((u: unknown): u is string => !!u),
      b64: items
        .map((i) => i?.b64_json)
        .filter((b: unknown): b is string => !!b),
      raw: data,
    };
  }

  /**
   * Read text aloud. Returns the audio itself, because there is nowhere else
   * for it to go — put it in your own storage or send it straight to a
   * browser.
   */
  async speech(
    text: string,
    options: AiCallOptions & { model?: string; voice?: string } = {},
  ): Promise<ArrayBuffer> {
    const { model, voice, ...rest } = options;
    const response = await this.request('audio/speech', {
      model: model ?? DEFAULT_SPEECH_MODEL,
      input: text,
      voice: voice ?? 'alloy',
      ...rest,
    });
    if (!response.ok) throw await this.toError(response);
    return response.arrayBuffer();
  }

  /** Make a short video clip. Providers differ in what they return, so the
   *  whole body comes back — most return a job to poll or a URL. */
  async video(
    prompt: string,
    options: AiCallOptions & { model?: string } = {},
  ): Promise<any> {
    const { model, ...rest } = options;
    return this.post('video/generations', { model, prompt, ...rest });
  }

  /**
   * Turn text into vectors, for search that understands meaning rather than
   * matching words.
   *
   * Takes one string or many. Many in one call is not a convenience — it is
   * how you index a catalogue without a thousand round trips.
   */
  async embed(
    input: string | string[],
    options: AiCallOptions & { model?: string } = {},
  ): Promise<EmbedResult> {
    const { model, ...rest } = options;
    const data = await this.post('embeddings', {
      model: model ?? DEFAULT_EMBED_MODEL,
      input,
      ...rest,
    });
    const items: any[] = Array.isArray(data?.data) ? data.data : [];
    return {
      // Sorted by the provider's own index rather than trusted in arrival
      // order: a vector matched to the wrong text is a search index that is
      // subtly, unfixably wrong, and nothing about it looks broken.
      vectors: [...items]
        .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
        .map((i) => i?.embedding ?? []),
      raw: data,
    };
  }

  // -------------------------------------------------------------------------

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const response = await this.request(path, body);
    if (!response.ok) throw await this.toError(response);
    return response.json();
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    if (!this.available) {
      throw new WorkserError(
        'Model calls are not configured. Workser injects ' +
          'WORKSER_AI_GATEWAY_URL and AI_GATEWAY_API_KEY into every app it ' +
          'deploys — if you are running outside one, pass ' +
          '`new Workser({ aiGatewayUrl, aiGatewayApiKey })`.',
        { code: 'config' },
      );
    }
    return this.config.fetch(`${this.config.aiGatewayUrl}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.aiGatewayApiKey}`,
      },
      body: JSON.stringify(body),
      // No retry, deliberately. Every one of these costs money, and a retried
      // image generation is a second image nobody asked for and a second
      // charge nobody can see.
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
  }

  private async toError(response: Response): Promise<WorkserError> {
    let message = `Model call failed (${response.status})`;
    try {
      const body: any = await response.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      // A non-JSON error body tells us nothing the status has not.
    }
    // 402 is the one worth naming: the organisation is out of credit, which is
    // a thing the app's owner can fix, unlike everything else in this list.
    return new WorkserError(message, {
      code: response.status === 402 ? 'insufficient_credit' : 'http',
      status: response.status,
    });
  }
}

/**
 * Defaults chosen so a caller who names no model gets something cheap and
 * fast rather than something expensive and slow. Every one is overridable per
 * call, and none of them is a promise about which model runs — the gateway
 * routes, and a model retired upstream should not require an SDK release.
 */
const DEFAULT_TEXT_MODEL = 'openai/gpt-5-mini';
const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-1';
const DEFAULT_SPEECH_MODEL = 'openai/tts-1';
const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-small';
