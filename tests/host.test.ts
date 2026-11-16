import { it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Authorization from '@deepseek-ai/dsh-authorization';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import * as plugin from '../lib/index.js';
import { DEFAULT_RECOVERY } from '../src/llm/recovery.js';
import z from '@deepseek-ai/schemastery';

it('rehydrates the settings wire schema without server-only validation callbacks', () => {
  expect(JSON.stringify(plugin.Config)).toBe(JSON.stringify(plugin.Config));
  const wire = JSON.parse(JSON.stringify(plugin.Config));
  const browserSchema = new z(wire);
  expect(browserSchema({ showSidebarQuota: true }).get()).toMatchObject({ showSidebarQuota: true, recovery: DEFAULT_RECOVERY });
  expect(() => plugin.Config({ recovery: { initialDelayMs: 5000, maxDelayMs: 1000 } })).toThrow();
});

it('validates both stream deadlines and supplies defaults for existing plugin configurations', () => {
  expect(plugin.Config().get()).toEqual({ showSidebarQuota: false, responseTimeoutMs: 120000, idleTimeoutMs: 120000, recovery: DEFAULT_RECOVERY });
  expect(plugin.Config({ showSidebarQuota: true }).get()).toEqual({ showSidebarQuota: true, responseTimeoutMs: 120000, idleTimeoutMs: 120000, recovery: DEFAULT_RECOVERY });
  expect(plugin.Config({ responseTimeoutMs: 180000, idleTimeoutMs: 240000 }).get()).toMatchObject({ responseTimeoutMs: 180000, idleTimeoutMs: 240000 });
  for (const key of ['responseTimeoutMs', 'idleTimeoutMs']) for (const value of [0, 999, 600001, 1000.5, Infinity, NaN]) {
    expect(() => plugin.Config({ [key]: value })).toThrow();
  }
  for (const recovery of [{ maxRetries: -1 }, { maxRetries: 4 }, { maxRetries: 1.5 }, { initialDelayMs: 0 }, { maxDelayMs: 0 }, { jitterRatio: -0.1 }, { jitterRatio: 1.1 }, { initialDelayMs: 5000, maxDelayMs: 1000 }]) expect(() => plugin.Config({ recovery })).toThrow();
  expect(plugin.Config({ recovery: { maxRetries: 0 } }).get().recovery.maxRetries).toBe(0);
});

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
      expect(remoteMethods(service).map(m => m.method).sort()).toEqual(['cancel', 'consent', 'login', 'loginCodex', 'logout', 'models', 'reconnect', 'usage', 'view']);
      expect(await service.reconnect({ confirmed: false })).toEqual({ status: 'reconnected', activeRequests: 0 });
      for (const invalid of [undefined, null, {}, [], { confirmed: 'yes' }, { confirmed: false, extra: true }]) await expect(service.reconnect(invalid)).rejects.toMatchObject({ code: 'PROTOCOL' });
      await fork.dispose(); expect(ctx.llm.listProviders()).toEqual([]); expect(ctx.authorization.list()).toEqual([]); expect(ctx.get('chatgptProvider')).toBeUndefined();
    }
  } finally { await ctx.fiber.dispose(); }
});
