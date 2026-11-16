import { it, expect } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';

it('mounts the shipped client through the real Gateway and carries reconnect options', async () => {
  const require = createRequire(import.meta.url); let client: any;
  runInNewContext(await readFile('lib/client.js', 'utf8'), { setInterval, clearInterval, setTimeout, clearTimeout, window: { __ModuleLoader__: { load: ({ factory }: any) => { client = factory(require); } } } });
  const calls: { endpoint: string; payload: unknown }[] = [];
  class Registry extends Service {
    remotes = { register: () => async () => {} };
    constructor(ctx: Context) { super(ctx, 'typert'); }
  }
  class Connection extends Service {
    interactions = 'none';
    rpc = {
      open: () => { throw new Error('This fixture must not open a socket'); },
      call: async (_path: string, endpoint: string, payload: unknown) => {
        calls.push({ endpoint, payload });
        return { ok: true, value: { status: 'reconnected', activeRequests: 0 } };
      },
    };
    constructor(ctx: Context) { super(ctx, 'connection'); }
  }
  const ctx = new Context();
  try {
    await ctx.plugin(Registry); await ctx.plugin(Connection); await ctx.plugin(GatewayClient);
    const remote = ctx.get('remote') as any;
    const dispose = await remote.$mount(client.contribution);
    expect(await remote.chatgptProvider.reconnect({ confirmed: false })).toEqual({ ok: true, value: { status: 'reconnected', activeRequests: 0 } });
    expect(calls).toEqual([{ endpoint: 'chatgptProvider/reconnect', payload: { args: { options: { confirmed: false } } } }]);
    const codec = client.contribution.descriptors.find((descriptor: any) => descriptor.method === 'reconnect').parameters[0].codec;
    for (const invalid of [undefined, null, {}, [], { confirmed: 'yes' }, { confirmed: false, extra: true }]) expect(() => codec.create().parse(invalid)).toThrow();
    expect(calls).toHaveLength(1);
    await dispose();
  } finally { await ctx.fiber.dispose(); }
});

it('P5 client page resolves its Remote namespace in an injected scope before React render', async () => {
  const api = { view: async () => ({ ok: true, value: { state: 'disconnected', sharing: false, signingIn: false } }), models: async () => ({ ok: true, value: [] }) };
  const components = new Map<string, (props?: any) => any>();
  const openedSections: string[] = [], replacementSections: string[] = [];
  let shell = { create: () => ({ actions: { openSection: (id: string) => { openedSections.push(id); } } }) };
  class Slots extends Service {
    constructor(ctx: Context) { super(ctx, 'slots'); }
    inject(_name: string, fn: () => void) { fn(); }
    register(options: { name: string }, value: (props?: any) => any) { components.set(options.name, value); return () => {}; }
    entriesOfSlot(name: string) { expect(name).toBe('sidebar.settings'); return [{ store: shell }]; }
  }
  class Namespace extends Service {
    constructor(ctx: Context) { super(ctx, 'remote.chatgptProvider', true); return Object.assign(this, api); }
  }
  class Remote extends Service {
    constructor(ctx: Context) { super(ctx, 'remote'); }
    get chatgptProvider() { return this.ctx.get('remote.chatgptProvider'); }
    async $mount() { await this.ctx.root.plugin(Namespace); return async () => {}; }
  }
  class ConfigForms extends Service {
    constructor(ctx: Context) { super(ctx, 'configForms'); }
    get(namespace: string) {
      expect(namespace).toBe('dsh-chatgpt-pass');
      return { getSnapshot: () => ({ status: 'ready', value: { showSidebarQuota: false }, writable: true }), subscribe: () => () => {}, set: async () => true };
    }
  }
  const require = createRequire(import.meta.url); let client: any;
  const source = await readFile('lib/client.js', 'utf8');
  runInNewContext(source, { setInterval, clearInterval, setTimeout, clearTimeout, window: { __ModuleLoader__: { load: ({ factory }: any) => { client = factory(require); } } } });
  const ctx = new Context();
  try {
    await ctx.plugin(Slots); await ctx.plugin(Remote); await ctx.plugin(ConfigForms); await ctx.plugin(client);
    expect(components.get('settings.section')).toBeTypeOf('function');
    // Invoking the outer render must not attempt a disallowed Cordis service lookup.
    const element = components.get('settings.section')!(); expect(element.props.client.api).toBeTruthy();
    expect(await element.props.client.api.view()).toMatchObject({ value: { state: 'disconnected' } });
    const sidebar = components.get('sidebar.footer.action')!({ wide: true });
    expect(sidebar.props.client).toBe(element.props.client);
    expect(sidebar.props.wide).toBe(true);
    expect(element.props.client.sidebar.getSnapshot().value.showSidebarQuota).toBe(false);
    sidebar.props.onOpenSettings();
    expect(openedSections).toEqual(['chatgpt-subscription']);
    // A settings-shell reload must not leave the entry bound to its previous instance.
    shell = { create: () => ({ actions: { openSection: (id: string) => { replacementSections.push(id); } } }) };
    sidebar.props.onOpenSettings();
    expect(openedSections).toEqual(['chatgpt-subscription']);
    expect(replacementSections).toEqual(['chatgpt-subscription']);
    // Both routes stay explicit; quota login is available to Plus/Pro too.
    expect(client.contribution.descriptors.map((d: any) => d.method)).toContain('loginCodex');
    expect(client.contribution.descriptors.map((d: any) => d.method)).toContain('usage');
    // No react-dom in this repo: assert the shipped client bundle carries both entry labels.
    expect(source).toContain('订阅登录（含余量）');
    expect(source).toContain('Plus / Pro / Business');
    expect(source).toContain('启用余量查询');
    expect(source).toContain('切换连接并重新授权');
    expect(source).toContain('实验性');
    expect(source).toContain('刷新用量');
    expect(source).toContain('订阅余量');
  } finally { await ctx.fiber.dispose(); }
});
