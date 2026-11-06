import { it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Authorization from '@deepseek-ai/dsh-authorization';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import * as plugin from '../lib/index.js';

it('P0/P1 real public services load/unload/reload provider, flow and client-facing safe methods', async () => {
  await mkdir('.validation', { recursive: true }); const home = await mkdtemp(resolve('.validation/host-'));
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(LocalCredentials, { dshHome: home, watch: false }); await ctx.plugin(Authorization);
    for (let n = 0; n < 2; n++) {
      expect(plugin.Config.meta.volatile).toBe(true);
      const fork = await ctx.plugin(plugin);
      expect(ctx.llm.listProviders()).toContainEqual({ id: 'chatgpt-subscription', name: 'ChatGPT 订阅' });
      expect(ctx.llm.listConfigurableProviders()).toContainEqual(expect.objectContaining({ nativeAuth: { oauth: true, env: [] } }));
      expect(ctx.authorization.list()).toHaveLength(1);
      const service = ctx.get('chatgptProvider') as any;
      expect((await service.view()).state).toBe('disconnected');
      expect(remoteMethods(service).map(m => m.method).sort()).toEqual(['cancel', 'consent', 'login', 'loginCodex', 'logout', 'models', 'usage', 'view']);
      await fork.dispose(); expect(ctx.llm.listProviders()).toEqual([]); expect(ctx.authorization.list()).toEqual([]); expect(ctx.get('chatgptProvider')).toBeUndefined();
    }
  } finally { await ctx.fiber.dispose(); }
});
