import { it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { modelReasoning } from '../src/llm/models.js';
import { PROVIDER } from '../src/llm/request.js';
import { connected, collect, scripted, message, sse } from './helpers.js';

it('exposes official catalog efforts through the real Harness runtime and sends the selected effort to Responses', async () => {
  const f = await connected(), ctx = new Context();
  const requests: { url: string; body: any }[] = [];
  const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-reasoning', display_name: 'Reasoning', visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }], default_reasoning_level: 'low' }] });
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return sse(scripted([message()]));
  });
  try {
    await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter([PROVIDER], adapter);
    const model = await ctx.llm.resolveModelInfo(PROVIDER, 'fixture-reasoning');
    expect(model.reasoning).toEqual({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'xhigh', name: 'Extra high' }], defaultEffort: 'low' });
    for (const effort of ['high', 'xhigh']) {
      const chunks = await collect(ctx.llm.stream({ provider: PROVIDER, model: 'fixture-reasoning', messages: [], reasoningEffort: ReasoningEffortId(effort) }));
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } });
      expect(requests.at(-1)).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { reasoning: { effort }, store: false, stream: true } });
      expect(requests.at(-1)!.body.include).toBeUndefined();
    }
  } finally { adapter.dispose(); f.session.dispose(); await ctx.fiber.dispose(); }
});

it('uses documented exact-model efforts when the official catalog omits them, without forcing an effort when none is selected', async () => {
  const f = await connected(); const requests: any[] = [];
  const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list' }] });
    requests.push(JSON.parse(String(init!.body))); return sse(scripted([message()]));
  });
  try {
    expect((await adapter.listModels())[0]?.reasoning?.efforts.map(e => String(e.id))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [], reasoningEffort: ReasoningEffortId('max') }));
    expect(requests[0].reasoning).toEqual({ effort: 'max' });
    await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [] }));
    expect(requests[1].reasoning).toBeUndefined();
    await expect(collect(adapter.stream({ provider: PROVIDER, model: 'gpt-6.1-sol', messages: [], reasoningEffort: ReasoningEffortId('none') }))).rejects.toMatchObject({ code: 'subscription_sharing_unsupported_capability' });
    expect(requests).toHaveLength(2);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('does not invent reasoning support for unknown models or override explicit server capabilities', () => {
  expect(modelReasoning({ slug: 'unknown' }, true)).toBeUndefined();
  expect(modelReasoning({ slug: 'gpt-6.1-sol-unknown' }, true)).toBeUndefined();
  expect(modelReasoning({ slug: 'gpt-6.1-sol' }, false)).toBeUndefined();
  expect(modelReasoning({ slug: 'gpt-6.1-sol', supports_reasoning: false }, true)).toBeUndefined();
  for (const levels of [[], null, false, [{ effort: '' }]]) expect(modelReasoning({ slug: 'gpt-6.1-sol', supported_reasoning_levels: levels }, true)).toBeUndefined();
  expect(modelReasoning({ slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'high', description: 'Deep' }, { effort: 'high' }, null, { effort: 'ultra' }], default_reasoning_level: 'medium' }, true))
    .toEqual({ efforts: [{ id: 'high', name: 'High', description: 'Deep' }, { id: 'ultra', name: 'Ultra' }] });
});

it.each(['gpt-6.1-sol', 'gpt-6-astra'])('%s has no invented none or minimal setting', model => {
  expect(modelReasoning({ slug: model }, true)?.efforts.map(e => String(e.id))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
});
it.each(['gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])('%s retains its documented none setting', model => {
  expect(modelReasoning({ slug: model }, true)?.efforts.map(e => String(e.id))).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

it('rejects an unsupported effort before sending an official inference request', async () => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'plain-model', display_name: 'Plain', visibility: 'list' }] });
    posts++; return sse(scripted([message()]));
  });
  try {
    await expect(collect(adapter.stream({ provider: PROVIDER, model: 'plain-model', messages: [], reasoningEffort: ReasoningEffortId('high') }))).rejects.toMatchObject({ code: 'subscription_sharing_unsupported_capability' });
    expect(posts).toBe(0);
  } finally { adapter.dispose(); f.session.dispose(); }
});
