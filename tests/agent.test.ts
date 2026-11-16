import { it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { connected, scripted, sse, message } from './helpers.js';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { PROVIDER, toolName } from '../src/llm/request.js';
import { DEFAULT_RECOVERY } from '../src/llm/recovery.js';

it('P4 actual Harness Agent recovers a failed follow-up request without repeating completed tools', async () => {
  const f = await connected(), ctx = new Context();
  const requests: any[] = []; const executed: string[] = [];
  try {
    await mountAgentLoopTestDependencies(ctx);
    const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
      const body = JSON.parse(String(init!.body)); requests.push(body);
      if (requests.length === 1) return sse(scripted(['echo', 'clock'].map((name, n) => ({ type: 'function_call', id: `item_${n}`, call_id: `original_call_${n}`, name: toolName(name), namespace: 'dsh', arguments: '{}', status: 'completed' }))));
      if (requests.length === 2) return Response.json({ error: { code: 'server_error' } }, { status: 503 });
      if (requests.length > 3) throw new Error('Unexpected repeated request');
      expect(body.input.filter((i: any) => i.type === 'function_call_output').map((i: any) => i.call_id)).toEqual(['original_call_0', 'original_call_1']);
      return sse(scripted([message('tools finished')]));
    }, Date.now, undefined, { ...DEFAULT_RECOVERY, initialDelayMs: 1, jitterRatio: 0 });
    ctx.llm.registerAdapter([PROVIDER], adapter);
    for (const name of ['echo', 'clock']) ctx.tools.register(defineContentToolFixture({ name, description: 'Read-only fixture tool', parameters: {}, isConcurrencySafe: () => true, async execute() { executed.push(name); return [{ type: 'text', text: `fixture:${name}` }]; } }));
    const loop = await mountAgentLoopTestHarness(ctx); const agent = await loop.create(SessionId('chatgpt-synthetic-tools'), { provider: PROVIDER, model: 'fixture-model' });
    const idle = new Promise<void>(resolve => { const dispose = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { dispose(); resolve(); } }); });
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run two synthetic read-only tools.' }] }));
    await idle;
    expect(executed.sort()).toEqual(['clock', 'echo']); expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[1]);
    const history = agent.session.snapshotEvents(); expect(history.filter(e => e.type === 'tool/result')).toHaveLength(2);
    expect(history.find(e => e.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } });
    expect(JSON.stringify(history)).toContain('tools finished');
  } finally { await ctx.fiber.dispose(); }
});

it.each(['upstream', 'protocol'] as const)('persists a safe %s failure in the Harness session without executing tools', async kind => {
  const f = await connected(), ctx = new Context();
  let posts = 0;
  try {
    await mountAgentLoopTestDependencies(ctx);
    const adapter = new ChatGPTAdapter(f.session, async url => {
      if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
      posts++;
      return kind === 'upstream' ? Response.json({ error: { code: 'unrecognized_code', message: 'SYNTHETIC_PRIVATE_DETAIL' } }, { status: 502 })
        : sse([{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_fixture', name: 'SYNTHETIC_PRIVATE_DETAIL' } }]);
    }, Date.now, undefined, { ...DEFAULT_RECOVERY, maxRetries: 0 });
    ctx.llm.registerAdapter([PROVIDER], adapter);
    const loop = await mountAgentLoopTestHarness(ctx);
    const agent = await loop.create(SessionId(`chatgpt-synthetic-${kind}-failure`), { provider: PROVIDER, model: 'fixture-model' });
    const idle = new Promise<void>(resolve => { const dispose = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { dispose(); resolve(); } }); });
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic failure check.' }] }));
    await idle;
    const history = agent.session.snapshotEvents();
    expect(history.find(e => e.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error', error: {
      code: kind === 'upstream' ? 'HTTP_502' : 'PROTOCOL',
      message: expect.stringContaining(kind === 'upstream' ? '上游网关' : 'stream.tool'),
    } } } });
    expect(history.filter(e => e.type === 'tool/call')).toHaveLength(0);
    expect(JSON.stringify(history)).not.toContain('SYNTHETIC_PRIVATE_DETAIL');
    expect(posts).toBe(1);
  } finally { await ctx.fiber.dispose(); f.session.dispose(); }
});
