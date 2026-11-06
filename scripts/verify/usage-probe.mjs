// Read-only usage probe: loads the built plugin against an isolated home and prints
// the public usage DTO. It must never contain account ids, email or spend details.
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
  const usage = await ctx.get('chatgptProvider').usage();
  const json = JSON.stringify(usage);
  console.log(JSON.stringify({ state: view.state, method: view.method, usage,
    pii: /email|account_id|user_id|credits|spend/i.test(json) }));
  await fork.dispose();
} finally {
  await ctx.fiber.dispose();
}
