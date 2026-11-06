import { it, expect } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

it('P5 client page resolves its Remote namespace in an injected scope before React render', async () => {
  const api = { view: async () => ({ ok: true, value: { state: 'disconnected', sharing: false, signingIn: false } }), models: async () => ({ ok: true, value: [] }) };
  let component: (() => any) | undefined;
  class Slots extends Service {
    constructor(ctx: Context) { super(ctx, 'slots'); }
    inject(_name: string, fn: () => void) { fn(); }
    register(_options: unknown, value: () => any) { component = value; return () => {}; }
  }
  class Namespace extends Service {
    constructor(ctx: Context) { super(ctx, 'remote.chatgptProvider', true); return Object.assign(this, api); }
  }
  class Remote extends Service {
    constructor(ctx: Context) { super(ctx, 'remote'); }
    get chatgptProvider() { return this.ctx.get('remote.chatgptProvider'); }
    async $mount() { await this.ctx.root.plugin(Namespace); return async () => {}; }
  }
  const require = createRequire(import.meta.url); let client: any;
  const source = await readFile('lib/client.js', 'utf8');
  runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }: any) => { client = factory(require); } } } });
  const ctx = new Context();
  try {
    await ctx.plugin(Slots); await ctx.plugin(Remote); await ctx.plugin(client);
    expect(component).toBeTypeOf('function');
    // Invoking the outer render must not attempt a disallowed Cordis service lookup.
    const element = component!(); expect(element.props.api).toBeTruthy();
    expect(await element.props.api.view()).toMatchObject({ value: { state: 'disconnected' } });
    // The two-path settings surface must expose both entries and keep the Business route labelled experimental.
    expect(client.contribution.descriptors.map((d: any) => d.method)).toContain('loginCodex');
    expect(client.contribution.descriptors.map((d: any) => d.method)).toContain('usage');
    // No react-dom in this repo: assert the shipped client bundle carries both entry labels.
    expect(source).toContain('推荐 Plus / Pro 会员');
    expect(source).toContain('推荐 Business 会员');
    expect(source).toContain('实验性');
    expect(source).toContain('刷新用量');
    expect(source).toContain('订阅余量');
  } finally { await ctx.fiber.dispose(); }
});
