import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-authorization';
import { KEY } from './auth/store.js';
import { SessionManager, type SessionView } from './auth/session.js';
import { ChatGPTAdapter } from './llm/adapter.js';
import { safeError, ProviderError } from './errors.js';
import type { UsageView } from './llm/usage.js';

export class ProviderService extends TypertRemoteService {
  constructor(ctx: Context, readonly session: SessionManager, readonly adapter: ChatGPTAdapter) { super(ctx, 'chatgptProvider'); }
  @Remote async view(): Promise<SessionView> {
    try { return await this.session.view(); } catch (e) { const error = safeError(e); return { state: 'reauth_required', sharing: false, signingIn: false, error: { ...error.diagnostic, message: error.message } }; }
  }
  @Remote login(): Promise<{ url: string }> { return this.begin('oauth'); }
  @Remote loginCodex(): Promise<{ url: string }> { return this.begin('codex'); }
  @Remote consent(): Promise<{ url: string }> { return this.begin('consent'); }
  private begin(method: string): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      let notified = false;
      void this.ctx.authorization.begin({ key: KEY, method, interaction: {
        notify: notice => { if (notice.url && !notified) { notified = true; resolve({ url: notice.url }); } },
        prompt: async () => { throw new ProviderError('AUTH_PROTOCOL'); },
      } }).then(outcome => { if (!notified) reject(new ProviderError(outcome.status === 'cancelled' ? 'AUTH_CANCELLED' : 'AUTH_PROTOCOL')); }, e => {
        const safe = safeError(e); this.session.report(safe); if (!notified) reject(safe);
      });
    });
  }
  @Remote async cancel(): Promise<void> { this.ctx.authorization.cancel(KEY); }
  @Remote async models(): Promise<{ id: string; name: string }[]> {
    try { await this.session.recover(); this.adapter.invalidate(); return (await this.adapter.listModels()).map(m => ({ id: m.id, name: m.name })); }
    catch (e) { throw safeError(e); }
  }
  @Remote async usage(): Promise<UsageView | null> {
    try { return (await this.adapter.usage()) ?? null; } catch (e) { throw safeError(e); }
  }
  @Remote async logout(): Promise<{ remoteRevoked: boolean }> { this.ctx.authorization.cancel(KEY); return this.session.logout(); }
}
