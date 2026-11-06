// Real-account agent probe: loads the built plugin against an isolated DSH_HOME,
// requires an existing connection, then runs one Harness Agent turn with a single
// read-only fixture tool. Prints structural evidence only (no tokens, no user
// prompts, no full model text).
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Authorization from '@deepseek-ai/dsh-authorization';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as plugin from '../../lib/index.js';

const home = resolve(process.env.DSH_PROBE_HOME ?? '.validation/desktop-home');
const model = process.env.DSH_PROBE_MODEL ?? 'gpt-5.6-sol';
const ctx = new Context();
let fork;
try {
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(LocalCredentials, { dshHome: home, watch: false });
  await ctx.plugin(Authorization);
  fork = await ctx.plugin(plugin);
  const view = await ctx.get('chatgptProvider').view();
  const models = (await ctx.llm.listModels('chatgpt-subscription')).map(m => m.id);
  if (view.state !== 'connected') {
    console.log(JSON.stringify({ result: 'NOT_CONNECTED', state: view.state, method: view.method, models }));
    process.exitCode = 2;
  } else {
    if (!models.includes(model)) throw new Error(`model ${model} is not in the current catalog`);
    const executed = [];
    ctx.tools.register(defineContentToolFixture({ name: 'probe_echo', description: 'Read-only probe tool. Returns a fixed string.',
      parameters: {},
      isConcurrencySafe: () => true,
      async execute() { executed.push('probe_echo'); return [{ type: 'text', text: 'probe:ok' }]; } }));
    const loop = await mountAgentLoopTestHarness(ctx);
    const agent = await loop.create(SessionId('codex-real-probe'), { provider: 'chatgpt-subscription', model });
    const idle = new Promise((resolveIdle, rejectIdle) => {
      const timer = setTimeout(() => rejectIdle(new Error('agent did not become idle within 180s')), 180_000);
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolveIdle(); } });
    });
    const started = Date.now();
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Call the probe_echo tool exactly once, then reply with one short sentence.' }] }));
    await idle;
    const events = agent.session.snapshotEvents();
    const toolResults = events.filter(e => e.type === 'tool/result');
    const turnEnd = events.find(e => e.type === 'turn/end');
    const reason = turnEnd?.data?.reason;
    const failures = events.filter(e => /error|fail/i.test(e.type)).slice(-3)
      .map(e => ({ type: e.type, code: e.data?.code ?? e.data?.error?.code ?? e.data?.reason?.code ?? null,
        message: String(e.data?.message ?? e.data?.error?.message ?? e.data?.reason?.message ?? '').slice(0, 240) }));
    const passed = reason?.kind === 'completed' && toolResults.length === 1 && executed.includes('probe_echo');
    console.log(JSON.stringify({ result: passed ? 'PASS' : 'FAIL', method: view.method, model, models, executed, toolResults: toolResults.length,
      turnReason: reason?.kind ?? null, reason: JSON.stringify(reason ?? null).slice(0, 600), lastTypes: events.slice(-8).map(e => e.type), failures, ms: Date.now() - started }));
    if (!passed) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ result: 'FAIL', name: error?.name, code: error?.code, message: String(error?.message ?? error).slice(0, 300) }));
  process.exitCode = 1;
} finally {
  try { await fork?.dispose(); } catch {}
  await ctx.fiber.dispose();
}
