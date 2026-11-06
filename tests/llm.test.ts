import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler, ToolCallId, createAssistantMessage, createUserMessage, createToolResultMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { connected, collect, events, scripted, message, sse, secret } from './helpers.js';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { translate, usage } from '../src/llm/stream.js';
import { buildRequest, toolMap, toolName, PROVIDER } from '../src/llm/request.js';
import { wireError } from '../src/errors.js';

const tools = [{ name: 'local.echo / 中文', description: 'Echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }, { name: 'local.clock', description: 'Clock', parameters: { type: 'object', properties: {} } }];
const opts = (messages: any[] = []): GenerateOptions => ({ provider: PROVIDER, model: 'fixture-model', messages, tools });
const call = (i: number, args = '{}') => ({ type: 'function_call', id: `item_${i}`, call_id: `call_${i}`, namespace: 'dsh', name: toolName(tools[i]!.name), arguments: args, status: 'completed' });
const signal = () => AbortSignal.timeout(5000);
function assembled(chunks: any[]) { const a = new BlockAssembler(); for (const c of chunks) a.push(c); return a; }
describe('Responses wire contract (synthetic)', () => {
  it('LLM-01/02/15 catalog models array, visibility and order, cache invalidation, attribution', async () => {
    const f = await connected(); let count = 0;
    const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/models'); expect(new Headers(init!.headers).get('user-agent')).toContain('deepseek-harness/'); count++;
      return Response.json({ models: [{ slug: 'b', display_name: 'B', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'a', display_name: 'A', visibility: 'list' }] });
    });
    expect((await adapter.listModels()).map(m => m.id)).toEqual(['b', 'a']); await adapter.listModels(); expect(count).toBe(1);
    adapter.invalidate(); await adapter.listModels(); expect(count).toBe(2); await f.session.logout(); expect(await adapter.listModels()).toEqual([]);
  });
  it('LLM-03 SDK sends exact allowlist without defaults, namespace tools, attribution and UTF8 byte splitting', async () => {
    const f = await connected(); let wire: any; let headers!: Headers;
    const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
      expect(String(url)).toBe('https://api.openai.com/v1/responses'); headers = new Headers(init!.headers); wire = JSON.parse(String(init!.body));
      return sse(scripted([message()]), 1);
    });
    const chunks = await collect(adapter.stream({ ...opts([{ role: 'user', content: [{ type: 'text', text: 'fixture input' }] }]), system: 'System', maxTokens: 1000, temperature: 0.8 }));
    expect(Object.keys(wire).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream', 'tools']); expect(wire).toMatchObject({ instructions: 'System', store: false, stream: true, tools: [{ type: 'namespace', name: 'dsh' }] });
    expect(headers.get('user-agent')).toContain('deepseek-harness/'); expect(headers.get('authorization')).toContain(secret);
    expect(assembled(chunks).blocks()).toEqual([{ type: 'text', text: '你好，世界' }]); expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } });
  });
  it('LLM-02 prepared call cannot use a different login generation', async () => {
    const f = await connected(); let posts = 0;
    const adapter = new ChatGPTAdapter(f.session, async url => { if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] }); posts++; return sse(scripted([message()])); });
    const bound = await adapter.prepareCall(PROVIDER, 'fixture-model'); await f.session.logout(); await f.login();
    await expect(collect(bound.stream(opts()))).rejects.toMatchObject({ code: 'CONNECTION_CHANGED' }); expect(posts).toBe(0);
  });
  it('LLM-04 multiple text blocks and refusal preserve ordering and phase', async () => {
    const m = { ...message(), content: [{ type: 'output_text', text: 'one', annotations: [] }, { type: 'refusal', refusal: 'cannot' }] };
    const chunks = await collect(translate(events(scripted([m], false)), 'fixture-model', 'identity', new Map(), signal()));
    const a = assembled(chunks); expect(a.blocks()).toEqual([{ type: 'text', text: 'one' }, { type: 'text', text: 'cannot' }]);
    expect((a.replayState!.blocks![0] as any).items[0].phase).toBe('final_answer');
  });
  it('LLM-05 interleaved tool deltas preserve original call IDs and raw JSON', async () => {
    const one = call(0, '{"value":"你好"}'), two = call(1);
    const stream = [
      { type: 'response.output_item.added', output_index: 0, item: { ...one, status: 'in_progress', arguments: '' } },
      { type: 'response.output_item.added', output_index: 1, item: { ...two, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"value":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"你好"}' },
      { type: 'response.output_item.done', output_index: 1, item: two }, { type: 'response.output_item.done', output_index: 0, item: one },
      { type: 'response.completed', response: { status: 'completed', output: [one, two] } },
    ];
    const chunks = await collect(translate(events(stream), 'fixture-model', 'identity', toolMap(tools), signal()));
    expect(assembled(chunks).blocks()).toEqual([{ type: 'tool-call', id: 'call_0', name: tools[0]!.name, arguments: one.arguments }, { type: 'tool-call', id: 'call_1', name: tools[1]!.name, arguments: '{}' }]);
    expect(chunks.filter((c: any) => c.type === 'finish')).toHaveLength(1);
  });
  it.each(['{"invalid":', '[]', 'null', '{}extra'])('LLM-06 invalid tool arguments fail without successful finish %s', async args => {
    const chunks: any[] = [];
    await expect((async () => { for await (const c of translate(events(scripted([call(0, args)])), 'fixture-model', 'identity', toolMap(tools), signal())) chunks.push(c); })()).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(chunks.some(c => c.type === 'finish')).toBe(false); expect(chunks.some(c => c.type === 'block-end')).toBe(false);
  });
  it('LLM-06 stable names are legal, collision-free and independent of order', () => {
    expect(toolMap([...tools].reverse())).toEqual(new Map([...toolMap(tools)].reverse())); expect([...toolMap(tools).keys()].every(s => /^[a-zA-Z0-9_]{1,64}$/.test(s))).toBe(true);
    expect(() => toolMap([tools[0]!, tools[0]!])).toThrow();
  });
  it.each(['response.failed', 'response.incomplete', 'EOF'])('LLM-07 terminal %s is never success', async terminal => {
    const stream = scripted([message()]).slice(0, -1); if (terminal !== 'EOF') stream.push({ type: terminal, response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: secret } } });
    const out: any[] = []; await expect((async () => { for await (const c of translate(events(stream), 'fixture-model', 'identity', new Map(), signal())) out.push(c); })()).rejects.toThrow();
    expect(out.some(c => c.type === 'finish')).toBe(false);
  });
  it('LLM-07 cancellation aborts fetch and runtime produces one aborted finish', async () => {
    const f = await connected(), ctx = new Context(); await ctx.plugin(LlmRuntime); let received!: AbortSignal;
    const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
      received = init!.signal!;
      return new Response(new ReadableStream({ start(controller) { received.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    ctx.llm.registerAdapter([PROVIDER], adapter); const cancel = new AbortController();
    const result = collect(ctx.llm.stream({ ...opts(), signal: cancel.signal }));
    while (!received) await new Promise(r => setTimeout(r, 1)); cancel.abort(); const out = await result;
    expect(received.aborted).toBe(true); expect(out.filter(c => c.type === 'finish')).toHaveLength(1); expect(out.at(-1)).toMatchObject({ reason: { kind: 'aborted' } }); await ctx.fiber.dispose();
  });
  it('LLM-08 usage is disjoint and invalid counters fail', () => {
    expect(usage({ input_tokens: 100, input_tokens_details: { cached_tokens: 30 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 112 })).toEqual({ inputTokens: 70, outputTokens: 12, cacheReadTokens: 30, reasoningTokens: 5, totalTokens: 112 });
    expect(() => usage({ input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } })).toThrow(); expect(usage(undefined)).toBeUndefined();
  });
  it('LLM-09 no automatic POST retry or fallback on 503', async () => {
    const f = await connected(); let posts = 0;
    const adapter = new ChatGPTAdapter(f.session, async url => { if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] }); posts++; return Response.json({ detail: secret }, { status: 503 }); });
    await expect(collect(adapter.stream(opts()))).rejects.toMatchObject({ code: 'HTTP_503' }); expect(posts).toBe(1); expect(adapter.providerRetryPolicy().maxRetries).toBe(0);
  });
  it('LLM-10/11 lossless replay, tool results, JSON persistence, cropping drops encrypted reasoning', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', status: 'completed', summary: [], encrypted_content: 'SYNTHETIC_OPAQUE_REASONING' };
    const chunks = await collect(translate(events(scripted([reasoning, call(0)])), 'fixture-model', 'identity', toolMap(tools), signal()));
    const a = assembled(chunks);
    const assistant = createAssistantMessage({ content: a.blocks(), source: { provider: PROVIDER, model: 'fixture-model', replayState: a.replayState } });
    const result = createToolResultMessage({ content: [{ type: 'text', text: 'tool failed safely' }], callId: ToolCallId('call_0'), isError: true });
    const history = JSON.parse(JSON.stringify([createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } }), assistant, result]));
    const wire = buildRequest(opts(history), 'identity'); expect(wire.input).toContainEqual(reasoningWithoutStatus(reasoning)); expect(wire.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_0', output: '{"error":"tool failed safely"}' });
    const cropped = { ...assistant, content: [], source: { ...assistant.source, replayState: { ...a.replayState, blocks: [] } } };
    expect(JSON.stringify(buildRequest(opts([cropped]), 'identity'))).not.toContain('SYNTHETIC_OPAQUE_REASONING');
  });
  it('LLM-11 edited text drops hidden metadata and never replays deleted words', async () => {
    const output = [{ type: 'reasoning', id: 'r', status: 'completed', summary: [], encrypted_content: 'opaque' }, message('deleted words')];
    const a = assembled(await collect(translate(events(scripted(output)), 'fixture-model', 'identity', new Map(), signal())));
    const m = createAssistantMessage({ content: [{ type: 'text', text: 'replacement' }], source: { provider: PROVIDER, model: 'fixture-model', replayState: a.replayState } });
    const wire = JSON.stringify(buildRequest(opts([m]), 'identity')); expect(wire).toContain('replacement'); expect(wire).not.toContain('deleted words'); expect(wire).not.toContain('opaque');
  });
  it.each([{ version: 99, identity: 'identity' }, { version: 1, identity: 'other-account' }])('LLM-12 incompatible envelope fails %j', meta => {
    const m = createAssistantMessage({ content: [{ type: 'text', text: 'fixture' }], source: { provider: PROVIDER, model: 'fixture-model', replayState: { response: { provider: PROVIDER, model: 'fixture-model', ...meta }, blocks: [{}] } } });
    expect(() => buildRequest(opts([m]), 'identity')).toThrow();
  });
  it('LLM-12 orphan tool output is rejected', () => {
    expect(() => buildRequest(opts([createToolResultMessage({ content: [{ type: 'text', text: 'x' }], callId: ToolCallId('orphan') })]), 'identity')).toThrow();
  });
  it('LLM-12 rejects tampered native payload instead of replaying a different tool or role', async () => {
    const a = assembled(await collect(translate(events(scripted([message('fixture')])), 'fixture-model', 'identity', new Map(), signal())));
    const replay = JSON.parse(JSON.stringify(a.replayState)); replay.blocks[0].items[0].role = 'system';
    const m = createAssistantMessage({ content: a.blocks(), source: { provider: PROVIDER, model: 'fixture-model', replayState: replay } });
    expect(() => buildRequest(opts([m]), 'identity')).toThrow();
  });
  it.each(['subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable', 'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'])('LLM-13 structured error %s has safe diagnostics', code => {
    const error = wireError({ error: { code, message: secret, param: 'tools[0]' } }, 403, 'req_fixture'); expect(error.diagnostic).toMatchObject({ code, status: 403, requestId: 'req_fixture', param: 'tools[0]' }); expect(JSON.stringify(error)).not.toContain(secret);
  });
  it('LLM-14 unsupported attachments and explicit unverified options are rejected', () => {
    expect(() => buildRequest(opts([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), 'identity')).toThrow(); expect(() => buildRequest({ ...opts(), reasoningEffort: 'high' as any }, 'identity')).toThrow();
  });
});
function reasoningWithoutStatus(item: any) { const { status, ...rest } = item; return rest; }
