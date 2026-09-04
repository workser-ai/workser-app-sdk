/**
 * One call, one answer.
 *
 * Every test here names the thing that went wrong before `workser.ai` existed
 * or that would go wrong if it were built the obvious way. The one worth
 * reading first is the credential test: the AI gateway is a different service
 * from Core API with a different key, and sending the project's business key
 * to it would be both a failed call and a credential in the wrong place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Workser, WorkserError } from '../src/index.js';

const BASE = {
  projectId: 'p_1',
  apiKey: 'wsr_run_abcdef1234567890',
  baseUrl: 'https://api.workser.ai',
  aiGatewayUrl: 'https://agent.workser.ai/gateway/v1',
  aiGatewayApiKey: 'gw_key_1',
  maxRetries: 0,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Records every request so a test can assert where it went and with what. */
function recorder(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return responses[Math.min(i++, responses.length - 1)]!;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

test('a model call goes to the gateway, not to Core API', async () => {
  // Two services, two credentials. Sending this to `baseUrl` would 404, and
  // sending the business key with it would put a credential somewhere it was
  // never issued for.
  const { calls, fetchImpl } = recorder([
    json({ model: 'openai/gpt-5-mini', choices: [{ message: { content: 'hi' } }] }),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  const result = await workser.ai.text('say hi');

  assert.equal(calls[0]!.url, 'https://agent.workser.ai/gateway/v1/chat/completions');
  assert.equal(
    (calls[0]!.init.headers as any).Authorization,
    'Bearer gw_key_1',
  );
  assert.equal(result.text, 'hi');
});

test('the reply is unwrapped, and the whole body is still there', async () => {
  // `choices[0].message.content` is the answer in every one of these calls,
  // and making every caller write that path is how an SDK earns its keep by
  // not existing. `raw` keeps the rest — token counts, finish reasons, a
  // provider field nobody has needed yet.
  const { fetchImpl } = recorder([
    json({
      model: 'openai/gpt-5-mini',
      choices: [{ message: { content: 'the answer' } }],
      usage: { prompt_tokens: 9 },
    }),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  const result = await workser.ai.text('q');

  assert.equal(result.text, 'the answer');
  assert.equal(result.raw.usage.prompt_tokens, 9);
});

test('a system prompt goes ahead of the question, not instead of it', async () => {
  const { calls, fetchImpl } = recorder([json({ choices: [] })]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  await workser.ai.text('what is the return policy?', {
    system: 'You are a shop assistant.',
  });

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are a shop assistant.' },
    { role: 'user', content: 'what is the return policy?' },
  ]);
});

test('provider-specific options are passed through untouched', async () => {
  // The gateway is an OpenAI-compatible proxy. A typed wrapper that
  // whitelisted fields would turn every new provider feature into an SDK
  // release, which is exactly the trap `options` exists to avoid.
  const { calls, fetchImpl } = recorder([json({ choices: [] })]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  await workser.ai.text('q', {
    model: 'anthropic/claude-sonnet-5',
    temperature: 0.2,
    reasoning: { effort: 'high' },
  });

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'anthropic/claude-sonnet-5');
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('images come back as URLs or as base64, because providers differ', async () => {
  // Picking one and dropping the other would silently lose the image for half
  // the models on the gateway.
  const { fetchImpl } = recorder([
    json({ data: [{ url: 'https://cdn/a.png' }, { b64_json: 'AAA' }] }),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  const result = await workser.ai.image('a cat');

  assert.deepEqual(result.urls, ['https://cdn/a.png']);
  assert.deepEqual(result.b64, ['AAA']);
});

test('embeddings keep the order of the inputs they came from', async () => {
  // A vector matched to the wrong text is a search index that is subtly and
  // unfixably wrong, and nothing about it looks broken from the outside.
  const { fetchImpl } = recorder([
    json({
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
    }),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  const result = await workser.ai.embed(['first', 'second']);

  assert.deepEqual(result.vectors, [[0.1], [0.2]]);
});

test('speech comes back as audio, not as a description of audio', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { calls, fetchImpl } = recorder([
    new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  const audio = await workser.ai.speech('hello');

  assert.equal(calls[0]!.url, 'https://agent.workser.ai/gateway/v1/audio/speech');
  assert.deepEqual(new Uint8Array(audio), bytes);
});

test('running out of credit says so, rather than saying "forbidden"', async () => {
  // 402 is the one refusal in this list the app's owner can fix in a minute.
  // Classifying it as a permissions problem sends them looking for one that
  // does not exist.
  const { fetchImpl } = recorder([
    json({ error: { message: 'Organization credit balance is insufficient.' } }, 402),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  await assert.rejects(
    () => workser.ai.text('q'),
    (error: unknown) => {
      assert.ok(error instanceof WorkserError);
      assert.equal(error.code, 'insufficient_credit');
      assert.match(error.message, /insufficient/i);
      return true;
    },
  );
});

test('an app with no gateway configured is told what is missing', async () => {
  // Workser injects both variables at provisioning, so this only happens
  // outside a Workser-deployed app — where the useful message names the two
  // variables rather than failing on an undefined URL.
  const { fetchImpl } = recorder([json({})]);
  const workser = new Workser({
    projectId: 'p_1',
    apiKey: 'wsr_run_abcdef1234567890',
    fetch: fetchImpl,
  });

  assert.equal(workser.ai.available, false);
  await assert.rejects(
    () => workser.ai.text('q'),
    (error: unknown) => {
      assert.ok(error instanceof WorkserError);
      assert.equal(error.code, 'config');
      assert.match(error.message, /WORKSER_AI_GATEWAY_URL/);
      return true;
    },
  );
});

test('streaming yields words, not SSE frames, across chunk boundaries', async () => {
  // A chunk boundary lands in the middle of a frame often enough that
  // anything simpler than buffering drops tokens — and a dropped token in a
  // streamed reply is invisible until a customer reads a sentence with a hole
  // in it.
  const encoder = new TextEncoder();
  const wire = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' + 'data: {"choi',
    'ces":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of wire) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const { fetchImpl } = recorder([
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  ]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  const out: string[] = [];
  for await (const delta of workser.ai.stream('say hello')) out.push(delta);

  assert.equal(out.join(''), 'Hello');
});


/**
 * Per-app attribution.
 *
 * A gateway key is minted per app, so one-shot model calls attribute
 * themselves. Agent runs had no equivalent, which is how a project with four
 * apps could see what the project spent and never which app spent it.
 */
test('a run says which app started it', async () => {
  const { calls, fetchImpl } = recorder([json({ id: 'run_1' })]);
  const workser = new Workser({
    ...BASE,
    webAppId: 'app_7',
    fetch: fetchImpl,
  });

  await workser.agents.run('agent_1', { message: 'go' });

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.web_app_id, 'app_7');
});

test('a run outside a Workser-deployed app claims no app at all', async () => {
  // Undefined is a real answer. Sending a placeholder would make a run look
  // attributed to something, and a customer reading a per-app bill cannot tell
  // a guess from a fact.
  const { calls, fetchImpl } = recorder([json({ id: 'run_1' })]);
  const workser = new Workser({ ...BASE, fetch: fetchImpl });

  await workser.agents.run('agent_1', { message: 'go' });

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.web_app_id, undefined);
});

test('a caller can attribute a run to a different app', async () => {
  const { calls, fetchImpl } = recorder([json({ id: 'run_1' })]);
  const workser = new Workser({ ...BASE, webAppId: 'app_7', fetch: fetchImpl });

  await workser.agents.run('agent_1', { message: 'go' }, { webAppId: 'app_9' });

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.web_app_id, 'app_9');
});
