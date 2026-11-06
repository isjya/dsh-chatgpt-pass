// Direct public-LLM probe: one Responses request through the plugin's adapter,
// with a single read-only tool definition. Prints chunk/finish structure or the
// mapped error; never prints tokens or prompt text.
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Authorization from '@deepseek-ai/dsh-authorization';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import * as plugin from '../../lib/index.js';

const home = resolve(process.env.DSH_PROBE_HOME ?? '.validation/desktop-home');
const ctx = new Context();
try {
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalCredentials, { dshHome: home, watch: false });
  await ctx.plugin(Authorization);
  const fork = await ctx.plugin(plugin);
  const view = await ctx.get('chatgptProvider').view();
  const models = (await ctx.llm.listModels('chatgpt-subscription')).map(m => m.id);
  if (view.state !== 'connected') {
    console.log(JSON.stringify({ result: 'NOT_CONNECTED', state: view.state, method: view.method, models }));
    process.exitCode = 2;
  } else {
    const model = process.env.DSH_PROBE_MODEL ?? models[0];
    const toolMode = process.env.DSH_PROBE_TOOLS ?? 'namespace';
    const reasoningEffort = process.env.DSH_PROBE_REASONING || undefined;
    const chunks = [];
    let failure;
    try {
      for await (const chunk of ctx.llm.stream({ provider: 'chatgpt-subscription', model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the probe_echo tool exactly once, then reply with one short sentence.' }] }],
        ...(toolMode === 'none' ? {} : { tools: [{ name: 'probe_echo', description: 'Read-only probe tool. Returns a fixed string.', parameters: {} }] }) })) chunks.push(chunk);
    } catch (error) { failure = { code: error?.code, status: error?.status, message: String(error?.message ?? error).slice(0, 240) }; }
    const kinds = [...new Set(chunks.map(c => c.type))].sort();
    const finish = chunks.find(c => c.type === 'finish');
    const kind = finish?.reason?.kind;
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text ?? '').join('');
    const calls = chunks.filter(c => c.type === 'tool-call' || c.type === 'tool-call-delta');
    const ok = !failure && kind !== 'error' && (calls.length > 0 || text.length > 0);
    console.log(JSON.stringify({ result: ok ? 'PASS' : 'FAIL', method: view.method, model, toolMode, reasoningEffort, models, chunkTypes: kinds,
      finishKind: kind ?? null, finish: finish?.reason ?? null, textLength: text.length, toolCalls: calls.length, chunkCount: chunks.length, failure }, null, 2));
    if (!ok) process.exitCode = 1;
  }
  await fork.dispose();
} finally {
  await ctx.fiber.dispose();
}
