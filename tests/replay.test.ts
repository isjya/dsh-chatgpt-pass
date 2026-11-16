import { describe, expect, it } from 'vitest';
import { BlockAssembler, ToolCallId, createAssistantMessage, createToolResultMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { ProviderError } from '../src/errors.js';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import type { CodexOAuth } from '../src/auth/codex.js';
import { buildRequest, PROVIDER, toolMap, toolName } from '../src/llm/request.js';
import { translate } from '../src/llm/stream.js';
import { collect, connected, events, message, scripted, sse } from './helpers.js';

const originalModel = 'fixture-terra', nextModel = 'fixture-sol';
const tools = [{ name: 'fixture.echo', description: 'Synthetic tool', parameters: { type: 'object', properties: {} } }];
const options = (model: string, messages: any[]): GenerateOptions => ({ provider: PROVIDER, model, messages, tools });
const result = (callId = 'call_fixture') => createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'synthetic result' }] });
async function assistant(model = originalModel, callId = 'call_fixture') {
  const output = [
    { type: 'reasoning', id: 'rs_hidden', summary: [], encrypted_content: `synthetic_hidden_${model}` },
    message('synthetic commentary', 'commentary'),
    { type: 'reasoning', id: 'rs_visible', summary: [{ type: 'summary_text', text: 'synthetic summary' }], encrypted_content: `synthetic_visible_${model}` },
    { type: 'function_call', id: 'fc_fixture', call_id: callId, namespace: 'dsh', name: toolName(tools[0]!.name), arguments: '{}' },
    { ...message(), content: [{ type: 'refusal', refusal: 'synthetic refusal' }] },
  ];
  const assembler = new BlockAssembler();
  for (const chunk of await collect(translate(events(scripted(output, false)), model, 'identity', toolMap(tools), AbortSignal.timeout(5000)))) assembler.push(chunk);
  return createAssistantMessage({ content: assembler.blocks(), source: { provider: PROVIDER, model, replayState: assembler.replayState } });
}

describe('Model changes with persisted replay', () => {
  it.each([[originalModel, nextModel], [nextModel, originalModel]])('projects %s history for %s without native reasoning or history mutation', async (from, to) => {
    const history = JSON.parse(JSON.stringify([await assistant(from), result()]));
    const before = JSON.stringify(history);
    const request = buildRequest(options(to, history), 'identity');
    expect(request.model).toBe(to);
    expect(request.input).toEqual([
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'synthetic commentary', annotations: [] }] },
      { type: 'function_call', namespace: 'dsh', name: toolName(tools[0]!.name), call_id: 'call_fixture', arguments: '{}' },
      { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'refusal', refusal: 'synthetic refusal' }] },
      { type: 'function_call_output', call_id: 'call_fixture', output: 'synthetic result' },
    ]);
    expect(JSON.stringify(request)).not.toContain('synthetic_hidden');
    expect(JSON.stringify(request)).not.toContain('synthetic_visible');
    expect(JSON.stringify(request)).not.toContain('synthetic summary');
    expect(JSON.stringify(history)).toBe(before);
  });

  it('keeps native reasoning for matching models in mixed history, including after switching back', async () => {
    const first = await assistant(), second = await assistant(nextModel, 'call_second');
    const history = [first, result(), second, result('call_second')];
    for (const model of [originalModel, nextModel]) {
      const request = buildRequest(options(model, history), 'identity');
      expect(request.input.filter((i: any) => i.type === 'reasoning').map((i: any) => i.encrypted_content)).toEqual([
        `synthetic_hidden_${model}`, `synthetic_visible_${model}`,
      ]);
      expect(request.input.filter((i: any) => i.type === 'function_call_output')).toHaveLength(2);
    }
  });

  it.each([originalModel, nextModel])('distinguishes a different login identity for target %s', async model => {
    const m = await assistant();
    expect(() => buildRequest(options(model, [m, result()]), 'other-identity')).toThrowError(expect.objectContaining({ code: 'REPLAY_IDENTITY_MISMATCH' }));
    const error = new ProviderError('REPLAY_IDENTITY_MISMATCH');
    expect(error.message).toContain('登录身份');
    expect(error.message).not.toContain('损坏');
  });

  it.each(['provider', 'version', 'model', 'blocks', 'role', 'tool', 'reasoning'])('still rejects invalid %s when switching models', async field => {
    const m = JSON.parse(JSON.stringify(await assistant()));
    const replay = m.source.replayState;
    if (field === 'provider') replay.response.provider = 'other-provider';
    if (field === 'version') replay.response.version = 99;
    if (field === 'model') delete replay.response.model;
    if (field === 'blocks') replay.blocks.pop();
    if (field === 'role') replay.blocks[0].items[1].role = 'system';
    if (field === 'tool') replay.blocks[2].items[0].arguments = '{"changed":true}';
    if (field === 'reasoning') replay.blocks[0].items[0].encrypted_content = {};
    expect(() => buildRequest(options(nextModel, [m, result()]), 'identity')).toThrowError(expect.objectContaining({ code: 'REPLAY_INVALID' }));
  });

  it('uses edited text and drops cropped blocks while switching models', async () => {
    const m = JSON.parse(JSON.stringify(await assistant()));
    m.content[0].text = 'synthetic replacement';
    m.content.splice(1, 1); m.source.replayState.blocks.splice(1, 1);
    const request = buildRequest(options(nextModel, [m, result()]), 'identity');
    expect(JSON.stringify(request)).toContain('synthetic replacement');
    expect(JSON.stringify(request)).not.toContain('synthetic commentary');
    expect(request.input.some((i: any) => i.type === 'reasoning')).toBe(false);
  });

  it.each(['edited', 'unanswered', 'orphan', 'duplicate'])('still rejects %s tool history when switching models', async kind => {
    const m = JSON.parse(JSON.stringify(await assistant()));
    let history = [m, result()];
    if (kind === 'edited') m.content.find((b: any) => b.type === 'tool-call').arguments = '{"changed":true}';
    if (kind === 'unanswered') history = [m];
    if (kind === 'orphan') history = [result()];
    if (kind === 'duplicate') history.push(m, result());
    expect(() => buildRequest(options(nextModel, history), 'identity')).toThrowError(expect.objectContaining({ code: 'REPLAY_INVALID' }));
  });

  it.each(['siwc', 'codex'])('continues across model changes and back through the %s adapter', async method => {
    const f = await connected();
    if (method === 'codex') {
      f.session.codex = { authorize: async () => ({
        tokens: { access: 'synthetic_access', refresh: 'synthetic_refresh', scopes: ['openid', 'offline_access'], receivedAt: Date.now(), expiresAt: Date.now() + 3600_000 },
        identity: { subject: 'synthetic_subject', issuer: 'https://auth.openai.com', accountId: 'synthetic_account' }, nonce: 'synthetic_nonce',
      }) } as unknown as CodexOAuth;
      await f.session.login({ method: 'codex', signal: new AbortController().signal } as any);
    }
    const requests: any[] = [];
    const outputs = [
      [{ type: 'reasoning', id: 'rs_original', summary: [], encrypted_content: 'synthetic_original' }, message('synthetic original answer'),
        { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', namespace: 'dsh', name: toolName(tools[0]!.name), arguments: '{}' }],
      [{ type: 'reasoning', id: 'rs_next', summary: [], encrypted_content: 'synthetic_next' }, message('synthetic next answer')],
      [message('synthetic switched back')],
    ];
    const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
      if (String(url).includes('/models')) return Response.json({ models: [originalModel, nextModel].map(slug => ({ slug, display_name: slug, visibility: 'list' })) });
      requests.push(JSON.parse(String(init!.body)));
      return sse(scripted(outputs[requests.length - 1]!));
    });
    const history: any[] = [{ role: 'user', content: [{ type: 'text', text: 'synthetic initial input' }] }];
    try {
      for (const model of [originalModel, nextModel, originalModel]) {
        const assembler = new BlockAssembler();
        for (const chunk of await collect(adapter.stream(options(model, history)))) assembler.push(chunk);
        expect(assembler.replayState!.response).toMatchObject({ model });
        history.push(createAssistantMessage({ content: assembler.blocks(), source: { provider: PROVIDER, model, replayState: assembler.replayState } }));
        if (requests.length === 1) history.push(result());
        history.push({ role: 'user', content: [{ type: 'text', text: 'synthetic continuation' }] });
      }
      expect(requests.map(r => r.model)).toEqual([originalModel, nextModel, originalModel]);
      expect(requests[1].input.some((i: any) => i.type === 'reasoning')).toBe(false);
      expect(requests[2].input.filter((i: any) => i.type === 'reasoning')).toMatchObject([{ encrypted_content: 'synthetic_original' }]);
      expect(JSON.stringify(requests[2])).not.toContain('synthetic_next');
      for (const request of requests.slice(1)) {
        expect(request.input.filter((i: any) => i.type === 'function_call_output')).toMatchObject([{ call_id: 'call_fixture', output: 'synthetic result' }]);
      }
    } finally { f.session.dispose(); }
  });
});
