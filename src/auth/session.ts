import { createHash, randomUUID } from 'node:crypto';
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization';
import { ProviderError, safeError } from '../errors.js';
import { Store, type Connection, type Method, type TokenSet } from './store.js';
import { OAuth, ISSUER } from './oauth.js';
import { CodexOAuth, CODEX_CLIENT_ID } from './codex.js';

export interface SessionView {
  state: Connection['state']; signingIn: boolean; account?: string; sharing: boolean; method?: Method;
  error?: { code: string; message: string; status?: number; requestId?: string; param?: string };
}
export interface Binding { generation: number; identity: string }
export interface Profile { method: Method; accountId?: string }
export function identity(c: Connection): string {
  return createHash('sha256').update(JSON.stringify([c.method, c.registration?.issuer, c.registration?.subject, c.registration?.clientId])).digest('hex');
}
function sharing(t: TokenSet): boolean { return ['resource.invoke', 'chatgpt.tokens.use.direct'].every(s => t.scopes.includes(s)); }
export class SessionManager {
  private readonly lifetime = new AbortController();
  private active = new AbortController();
  private refreshPromise?: Promise<Connection>;
  private signingIn = false;
  private observedGeneration?: number;
  private lastError?: ProviderError;
  // Replaced in tests with a fake Codex transport; the production instance owns the Codex OAuth client.
  codex: CodexOAuth = new CodexOAuth();
  constructor(readonly store: Store, readonly oauth: OAuth, readonly changed: () => void = () => {}, readonly now = Date.now, readonly loginTimeout = 300000) {}
  get signal(): AbortSignal { return AbortSignal.any([this.lifetime.signal, this.active.signal]); }
  dispose(): void { this.lifetime.abort(); this.active.abort(); }
  async observe(): Promise<void> {
    const c = await this.store.read();
    if (!this.signingIn && this.observedGeneration !== undefined && c?.generation !== this.observedGeneration) {
      this.active.abort(); this.active = new AbortController(); this.observedGeneration = c?.generation;
    }
  }
  report(e: unknown): void { this.lastError = safeError(e); this.changed(); }
  async view(): Promise<SessionView> {
    const c = await this.store.read();
    const email = c?.registration?.email;
    return { state: c?.state ?? 'disconnected', signingIn: this.signingIn, sharing: c?.state === 'connected', method: c?.method ?? 'siwc',
      ...(email ? { account: `${email.slice(0, 1)}***@${email.split('@')[1] ?? '…'}` } : c?.registration?.subject ? { account: '已验证的 ChatGPT 账号' } : {}),
      ...(this.lastError ? { error: { ...this.lastError.diagnostic, message: this.lastError.message } } : {}) };
  }
  async profile(): Promise<Profile> {
    const c = await this.store.read();
    return { method: c?.method ?? 'siwc', ...(c?.registration?.accountId ? { accountId: c.registration.accountId } : {}) };
  }
  async login(session: AuthorizationSession): Promise<void> {
    if (session.method === 'codex') return this.loginCodex(session);
    if (this.signingIn) throw new ProviderError('AUTH_BUSY');
    this.lifetime.signal.throwIfAborted(); this.signingIn = true; this.lastError = undefined;
    const attempt = randomUUID();
    const signal = AbortSignal.any([session.signal, this.lifetime.signal, this.active.signal, AbortSignal.timeout(this.loginTimeout)]);
    this.changed();
    try {
      const c = await this.store.update(c => {
        signal.throwIfAborted(); c.generation++; c.attempt = attempt;
        // Switching from a Codex connection must not reuse its first-party client id,
        // id_token or tokens: start a clean disconnected SIWC state for this attempt.
        if (c.method === 'codex') { c.method = 'siwc'; c.state = 'disconnected'; delete c.registration; delete c.tokens; delete c.checkpoint; }
      });
      const result = await this.oauth.authorize(c, session.method === 'consent', signal, url => session.notify({ message: '请在官方网页完成 ChatGPT 登录与订阅共享授权。', url }), async clientId => {
        await this.store.update(current => {
          this.assertAttempt(current, c.generation, attempt, signal);
          if (!current.registration) current.registration = { clientId };
        });
      });
      await this.store.update(current => {
        this.assertAttempt(current, c.generation, attempt, signal);
        current.checkpoint = { tokens: result.tokens, nonce: result.nonce };
      });
      // Identity verification does not run while holding the credential writer lock.
      const verified = await this.oauth.verify(result.tokens, result.clientId, result.nonce, c.registration, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
      await this.store.update(current => {
        this.assertAttempt(current, c.generation, attempt, signal);
        current.method = 'siwc';
        current.registration = { clientId: result.clientId, ...verified };
        current.tokens = result.tokens; current.state = sharing(result.tokens) ? 'connected' : 'identity_only';
        delete current.checkpoint; delete current.attempt;
      });
      this.active.abort(); this.active = new AbortController();
    } catch (e) {
      this.lastError = signal.aborted ? new ProviderError('AUTH_CANCELLED') : safeError(e);
      throw this.lastError;
    } finally {
      await this.store.update(c => {
        if (c.attempt === attempt) {
          delete c.attempt;
          if (this.lastError && this.lastError.code !== 'AUTH_TEMPORARY') delete c.checkpoint;
        }
      }).catch(() => {});
      this.signingIn = false; this.changed();
    }
  }
  private async loginCodex(session: AuthorizationSession): Promise<void> {
    if (this.signingIn) throw new ProviderError('AUTH_BUSY');
    this.lifetime.signal.throwIfAborted(); this.signingIn = true; this.lastError = undefined;
    const attempt = randomUUID();
    const signal = AbortSignal.any([session.signal, this.lifetime.signal, this.active.signal, AbortSignal.timeout(this.loginTimeout)]);
    this.changed();
    try {
      const c = await this.store.update(current => { signal.throwIfAborted(); current.generation++; current.attempt = attempt; });
      const result = await this.codex.authorize(signal, url => session.notify({ message: '请在官方网页完成 Codex 登录（Business 工作区）。', url }));
      await this.store.update(current => {
        this.assertAttempt(current, c.generation, attempt, signal);
        current.method = 'codex';
        current.registration = { clientId: CODEX_CLIENT_ID, subject: result.identity.subject, issuer: ISSUER,
          ...(result.identity.email ? { email: result.identity.email } : {}), ...(result.identity.accountId ? { accountId: result.identity.accountId } : {}) };
        current.tokens = result.tokens; current.state = 'connected';
        delete current.checkpoint; delete current.attempt;
      });
      this.active.abort(); this.active = new AbortController();
    } catch (e) {
      this.lastError = signal.aborted ? new ProviderError('AUTH_CANCELLED') : safeError(e);
      throw this.lastError;
    } finally {
      await this.store.update(c => { if (c.attempt === attempt) delete c.attempt; }).catch(() => {});
      this.signingIn = false; this.changed();
    }
  }
  private assertAttempt(c: Connection, generation: number, attempt: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (c.generation !== generation || c.attempt !== attempt) throw new ProviderError('CONNECTION_CHANGED');
  }
  async binding(): Promise<Binding> {
    const c = await this.usable(); return { generation: c.generation, identity: identity(c) };
  }
  async recover(): Promise<void> {
    if (!(await this.store.read())?.checkpoint) return;
    this.refreshPromise ??= this.refresh().finally(() => { this.refreshPromise = undefined; });
    await this.refreshPromise;
  }
  async access(binding?: Binding): Promise<{ token: string; binding: Binding }> {
    const c = await this.usable();
    if (binding && (binding.generation !== c.generation || binding.identity !== identity(c))) throw new ProviderError('CONNECTION_CHANGED');
    this.observedGeneration = c.generation;
    return { token: c.tokens!.access, binding: { generation: c.generation, identity: identity(c) } };
  }
  private async usable(): Promise<Connection> {
    this.lifetime.signal.throwIfAborted();
    let c = await this.store.read();
    if (c?.checkpoint) { await this.recover(); c = await this.store.read(); }
    if (!c || c.state === 'disconnected' || c.state === 'reauth_required') throw new ProviderError('AUTH_REQUIRED');
    if (c.method === 'siwc' && c.state === 'identity_only') throw new ProviderError('SHARING_DISABLED');
    if (c.attempt) throw new ProviderError('AUTH_BUSY');
    const refreshAt = Math.max(c.tokens!.expiresAt - 60000, c.tokens!.earliestRefreshAt ?? 0);
    if (c.checkpoint || refreshAt <= this.now()) {
      this.refreshPromise ??= this.refresh().finally(() => { this.refreshPromise = undefined; });
      c = await this.refreshPromise;
    }
    if (c.state !== 'connected' || !c.tokens || c.checkpoint) throw new ProviderError(c.state === 'identity_only' ? 'SHARING_DISABLED' : 'AUTH_REQUIRED');
    if (c.tokens.expiresAt <= this.now()) throw new ProviderError('AUTH_REQUIRED');
    return c;
  }
  private async refresh(): Promise<Connection> {
    let failure: ProviderError | undefined;
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(18000)]);
    const result = await this.store.update(async c => {
      signal.throwIfAborted();
      if ((!c.checkpoint && (c.state !== 'connected' || !c.tokens)) || !c.registration || c.attempt) throw new ProviderError('AUTH_REQUIRED');
      if (!c.checkpoint && Math.max(c.tokens!.expiresAt - 60000, c.tokens!.earliestRefreshAt ?? 0) > this.now()) return;
      try {
        const nonce = c.checkpoint?.nonce;
        if (c.method === 'codex') {
          const tokens = c.checkpoint?.tokens ?? await this.codex.refresh(c.tokens!, signal);
          c.checkpoint = { tokens };
          const prior = c.registration.subject ? { subject: c.registration.subject, issuer: ISSUER,
            ...(c.registration.email ? { email: c.registration.email } : {}), ...(c.registration.accountId ? { accountId: c.registration.accountId } : {}) } : undefined;
          const verified = await this.codex.verify(tokens, nonce, prior, signal);
          signal.throwIfAborted();
          if (!tokens.id) tokens.id = c.tokens?.id;
          c.registration = { clientId: CODEX_CLIENT_ID, subject: verified.subject, issuer: ISSUER,
            ...(verified.email ? { email: verified.email } : {}), ...(verified.accountId ? { accountId: verified.accountId } : {}) };
          c.tokens = tokens; c.state = 'connected'; delete c.checkpoint;
          return;
        }
        const tokens = c.checkpoint?.tokens ?? await this.oauth.exchange({ grant_type: 'refresh_token', client_id: c.registration.clientId, refresh_token: c.tokens!.refresh }, signal);
        // Save rotated credentials if key retrieval is temporarily unavailable. Never use them before validation.
        c.checkpoint = { tokens, nonce };
        const verified = await this.oauth.verify(tokens, c.registration.clientId, nonce, c.registration, signal);
        signal.throwIfAborted();
        if (!tokens.id) tokens.id = c.tokens?.id;
        c.registration = { clientId: c.registration.clientId, ...verified };
        c.tokens = tokens; c.state = sharing(tokens) ? 'connected' : 'identity_only'; delete c.checkpoint;
      } catch (e) {
        failure = safeError(e);
        if (failure.code === 'AUTH_INVALID' || failure.code === 'AUTH_PROTOCOL') {
          c.state = 'reauth_required'; c.generation++; delete c.tokens; delete c.checkpoint;
        }
      }
    });
    if (failure) { this.report(failure); throw failure; }
    this.lastError = undefined; this.changed(); return result;
  }
  async logout(): Promise<{ remoteRevoked: boolean }> {
    this.active.abort(); this.active = new AbortController();
    let token: string | undefined, clientId: string | undefined, method: Method | undefined;
    await this.store.update(c => {
      token = c.checkpoint?.tokens.refresh ?? c.tokens?.refresh; clientId = c.registration?.clientId; method = c.method;
      c.generation++; c.state = 'disconnected'; delete c.tokens; delete c.checkpoint; delete c.attempt;
    });
    this.changed();
    const remoteRevoked = token ? method === 'codex' ? await this.codex.revoke(token) : clientId ? await this.oauth.revoke(clientId, token) : true : true;
    this.lastError = undefined;
    return { remoteRevoked };
  }
}
