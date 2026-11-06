import { it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { connected, scripted, sse, message } from './helpers.js';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { PROVIDER, toolName } from '../src/llm/request.js';

it('P4 actual Harness Agent executes two safe tools then sends results back without duplicate execution', async () => {
  const f = await connected(), ctx = new Context();
  const requests: any[] = []; const executed: string[] = [];
  try {
    await mountAgentLoopTestDependencies(ctx);
    const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
      const body = JSON.parse(String(init!.body)); requests.push(body);
      if (requests.length === 1) return sse(scripted(['echo', 'clock'].map((name, n) => ({ type: 'function_call', id: `item_${n}`, call_id: `original_call_${n}`, name: toolName(name), namespace: 'dsh', arguments: '{}', status: 'completed' }))));
      if (requests.length > 2) throw new Error('Unexpected repeated request');
      expect(body.input.filter((i: any) => i.type === 'function_call_output').map((i: any) => i.call_id)).toEqual(['original_call_0', 'original_call_1']);
      return sse(scripted([message('tools finished')]));
    });
    ctx.llm.registerAdapter([PROVIDER], adapter);
    for (const name of ['echo', 'clock']) ctx.tools.register(defineContentToolFixture({ name, description: 'Read-only fixture tool', parameters: {}, isConcurrencySafe: () => true, async execute() { executed.push(name); return [{ type: 'text', text: `fixture:${name}` }]; } }));
    const loop = await mountAgentLoopTestHarness(ctx); const agent = await loop.create(SessionId('chatgpt-synthetic-tools'), { provider: PROVIDER, model: 'fixture-model' });
    const idle = new Promise<void>(resolve => { const dispose = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { dispose(); resolve(); } }); });
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run two synthetic read-only tools.' }] }));
    await idle;
    expect(executed.sort()).toEqual(['clock', 'echo']); expect(requests).toHaveLength(2);
    const history = agent.session.snapshotEvents(); expect(history.filter(e => e.type === 'tool/result')).toHaveLength(2);
    expect(history.find(e => e.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } });
    expect(JSON.stringify(history)).toContain('tools finished');
  } finally { await ctx.fiber.dispose(); }
});
