// Read-only status probe for one isolated DSH_HOME: loads the built plugin with the
// host's public credentials/LLM services and prints the connection method, state and
// model IDs. Tokens, account IDs and prompts are never printed.
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
  const models = await ctx.llm.listModels('chatgpt-subscription');
  console.log(JSON.stringify({ homePurpose: 'isolated', state: view.state, method: view.method, signingIn: view.signingIn,
    accountPresent: Boolean(view.account), sharing: view.sharing, models: models.map(m => m.id) }));
  await fork.dispose();
} finally {
  await ctx.fiber.dispose();
}
