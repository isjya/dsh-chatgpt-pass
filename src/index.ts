import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-authorization';
import { Store, KEY } from './auth/store.js';
import { OAuth } from './auth/oauth.js';
import { SessionManager } from './auth/session.js';
import { ChatGPTAdapter } from './llm/adapter.js';
import { PROVIDER } from './llm/request.js';
import { RecoverySchema, type RecoveryConfig } from './llm/recovery.js';
import { ProviderService } from './service.js';

export const name = 'dsh-chatgpt-pass';
export const inject = ['llm', 'credentials', 'authorization'];
// A public volatile Config lets the host Models page join this entry's settings namespace.
// Credentials have no place in this schema.
export const Config = z.object({ showSidebarQuota: z.boolean().default(false),
  responseTimeoutMs: z.number().min(1000).max(600000).step(1).default(120000),
  idleTimeoutMs: z.number().min(1000).max(600000).step(1).default(120000),
  recovery: RecoverySchema,
}).default({}).volatile();
export function apply(ctx: Context, config: Volatile<{ showSidebarQuota: boolean; responseTimeoutMs: number; idleTimeoutMs: number; recovery: RecoveryConfig }>): void {
  let adapter: ChatGPTAdapter;
  const session = new SessionManager(new Store(ctx.credentials), new OAuth(), () => {
    adapter?.invalidate(); ctx.emit('llm/models-updated', PROVIDER);
  });
  adapter = new ChatGPTAdapter(session, fetch, Date.now, () => config.get(), () => config.get().recovery);
  new ProviderService(ctx, session, adapter);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'ChatGPT 订阅', settingsNs: name, settingsPath: [], nativeAuth: { env: [], oauth: true }, defaultBaseURL: 'https://api.openai.com/v1' }]);
  ctx.authorization.registerFlow({ key: KEY, label: 'ChatGPT 订阅', methods: [{ id: 'oauth', label: 'ChatGPT 登录（推荐 Plus / Pro 会员）' }, { id: 'consent', label: '启用订阅共享' }, { id: 'codex', label: '订阅登录（Plus / Pro / Business，含余量，实验性）' }], run: s => session.login(s) });
  ctx.on('credentials/record-updated', key => { if (key === KEY) { adapter.invalidate(); void session.observe().catch(() => {}); ctx.emit('llm/models-updated', PROVIDER); } });
  ctx.effect(() => () => { adapter.dispose(); session.dispose(); });
}
