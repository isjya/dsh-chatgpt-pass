import assert from 'node:assert/strict';
import * as provider from '../../lib/index.js';
export const inject = ['llm', 'credentials', 'authorization'];
export async function apply(ctx) {
  try {
    const fork = await ctx.plugin(provider);
    assert(ctx.llm.listProviders().some(p => p.id === 'chatgpt-subscription'));
    assert(ctx.llm.listConfigurableProviders().some(p => p.provider === 'chatgpt-subscription' && p.nativeAuth.oauth));
    assert(ctx.authorization.list().some(f => String(f.key) === 'chatgpt-subscription/session'));
    assert.equal((await ctx.get('chatgptProvider').view()).state, 'disconnected');
    assert.deepEqual(await ctx.llm.listModels('chatgpt-subscription'), []);
    await fork.dispose();
    assert(!ctx.llm.listProviders().some(p => p.id === 'chatgpt-subscription'));
    assert(!ctx.authorization.list().some(f => String(f.key) === 'chatgpt-subscription/session'));
    console.log('DSH_CHATGPT_PROBE ' + JSON.stringify({ result: 'PASS', node: process.version, load: true, provider: true, flow: true, models: 'disconnected-empty', cleanup: true }));
    setTimeout(() => process.exit(0), 100);
  } catch {
    console.error('DSH_CHATGPT_PROBE FAIL'); process.exitCode = 1; setTimeout(() => process.exit(1), 100);
  }
}
