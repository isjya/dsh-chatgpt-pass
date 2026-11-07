import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { ProviderError, object } from '../errors.js';
import { ISSUER, json, type Fetch } from './oauth.js';
import type { TokenSet } from './store.js';

// Codex ("legacy") sign-in uses OpenAI's first-party Codex OAuth client and the
// Codex backend. It exists for ChatGPT Business/Team workspaces whose policy
// rejects third-party SIWC agents. This is not an official third-party path.
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_ORIGINATOR = 'dsh-chatgpt-pass';
// The catalog filters models by this version (newer models declare minimal_client_version).
// The Codex backend accepts a plain semver; older clients see a reduced catalog.
export const CODEX_CLIENT_VERSION = '1.0.0';
export const CODEX_SCOPES = 'openid profile email offline_access';
const DEFAULT_PORTS = [1455, 1457];
export interface CodexIdentity { subject: string; issuer: string; email?: string; accountId?: string }
export interface CodexAuthorization { tokens: TokenSet; identity: CodexIdentity; nonce: string }
interface Discovery { jwks_uri: string; revocation_endpoint?: string }

export class CodexOAuth {
  private discoveryPromise?: Promise<Discovery>;
  constructor(readonly transport: Fetch = fetch, readonly now = Date.now, readonly ports: number[] = DEFAULT_PORTS, readonly host = 'localhost') {}
  private endpoint(value: unknown): string {
    if (typeof value !== 'string') throw new ProviderError('AUTH_PROTOCOL');
    let u: URL;
    try { u = new URL(value); } catch { throw new ProviderError('AUTH_PROTOCOL'); }
    if (u.origin !== ISSUER || u.username || u.password || u.hash || u.search) throw new ProviderError('AUTH_PROTOCOL');
    return u.href;
  }
  private discovery(signal: AbortSignal): Promise<Discovery> {
    this.discoveryPromise ??= (async () => {
      const r = await this.transport(`${ISSUER}/.well-known/openid-configuration`, { signal, redirect: 'error' });
      if (!r.ok) throw new ProviderError('AUTH_TEMPORARY');
      const d = object(await json(r));
      if (d.issuer !== ISSUER) throw new ProviderError('AUTH_PROTOCOL');
      return { jwks_uri: this.endpoint(d.jwks_uri), ...(d.revocation_endpoint ? { revocation_endpoint: this.endpoint(d.revocation_endpoint) } : {}) };
    })().catch(e => { this.discoveryPromise = undefined; throw e instanceof ProviderError ? e : new ProviderError('AUTH_TEMPORARY'); });
    return this.discoveryPromise;
  }
  private parse(t: Record<string, any>, prior?: TokenSet): TokenSet {
    if (String(t.token_type).toLowerCase() !== 'bearer' || typeof t.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(t.access_token)
      || typeof t.scope !== 'string' || typeof t.expires_in !== 'number' || !Number.isFinite(t.expires_in) || t.expires_in <= 0
      || (t.id_token !== undefined && typeof t.id_token !== 'string')) throw new ProviderError('AUTH_PROTOCOL');
    const refresh = typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : prior?.refresh;
    if (!refresh) throw new ProviderError('AUTH_PROTOCOL');
    const receivedAt = this.now();
    if (!Number.isFinite(receivedAt + t.expires_in * 1000)) throw new ProviderError('AUTH_PROTOCOL');
    return { access: t.access_token, refresh, id: typeof t.id_token === 'string' ? t.id_token : prior?.id, scopes: t.scope.split(/\s+/).filter(Boolean), receivedAt,
      expiresAt: receivedAt + t.expires_in * 1000,
      earliestRefreshAt: typeof t.earliest_refresh_at === 'number' && Number.isFinite(t.earliest_refresh_at) ? t.earliest_refresh_at * 1000 : undefined };
  }
  async exchange(fields: Record<string, string>, signal: AbortSignal, prior?: TokenSet): Promise<TokenSet> {
    let r: Response;
    try { r = await this.transport(`${ISSUER}/oauth/token`, { method: 'POST', body: new URLSearchParams({ ...fields, client_id: CODEX_CLIENT_ID }), signal, redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); }
    catch { signal.throwIfAborted(); throw new ProviderError('AUTH_TEMPORARY'); }
    const t = object(await json(r));
    if (!r.ok) {
      if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client'].includes(t.error)) throw new ProviderError('AUTH_INVALID', r.status);
      throw new ProviderError('AUTH_TEMPORARY', r.status);
    }
    return this.parse(t, prior);
  }
  async verify(tokens: TokenSet, nonce: string | undefined, prior: CodexIdentity | undefined, signal: AbortSignal): Promise<CodexIdentity> {
    if (!tokens.id) {
      if (!prior?.subject || prior.issuer !== ISSUER) throw new ProviderError('AUTH_INVALID');
      return prior;
    }
    const d = await this.discovery(signal);
    const keys = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 5000, [customFetch]: (url, init) => this.transport(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' }) });
    try {
      const { payload } = await jwtVerify(tokens.id, keys, { issuer: ISSUER, audience: CODEX_CLIENT_ID, algorithms: ['RS256'], clockTolerance: 30, currentDate: new Date(this.now()), requiredClaims: ['exp', 'iat', 'sub'] });
      if (signal.aborted) throw new ProviderError('AUTH_CANCELLED');
      if (!payload.sub || typeof payload.iat !== 'number' || payload.iat > this.now() / 1000 + 30 || (nonce !== undefined && payload.nonce !== nonce)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== CODEX_CLIENT_ID) || (payload.azp !== undefined && payload.azp !== CODEX_CLIENT_ID)
        || (prior?.subject && (prior.subject !== payload.sub || prior.issuer !== payload.iss))) throw new ProviderError('AUTH_INVALID');
      return { subject: payload.sub, issuer: ISSUER, email: typeof payload.email === 'string' ? payload.email : prior?.email, ...account(payload, prior?.accountId) };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const code = e && typeof e === 'object' ? Reflect.get(e, 'code') : undefined;
      if (typeof code === 'string' && (code.startsWith('ERR_JWT') || code.startsWith('ERR_JWS') || code === 'ERR_JOSE_ALG_NOT_ALLOWED' || code === 'ERR_JWKS_NO_MATCHING_KEY')) throw new ProviderError('AUTH_INVALID');
      throw new ProviderError('AUTH_TEMPORARY');
    }
  }
  async authorize(signal: AbortSignal, notify: (url: string) => void): Promise<CodexAuthorization> {
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const server = createServer();
    let consumed = false;
    let accept!: (code: string) => void, reject!: (e: unknown) => void;
    const callback = new Promise<string>((a, b) => { accept = a; reject = b; });
    void callback.catch(() => {});
    const abort = () => reject(new ProviderError('AUTH_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      let port: number | undefined;
      for (const candidate of this.ports) {
        const bound = await new Promise<number | undefined>(resolve => {
          const onError = () => { server.removeListener('listening', onListening); resolve(undefined); };
          const onListening = () => { server.removeListener('error', onError); const address = server.address(); resolve(address && typeof address !== 'string' ? address.port : undefined); };
          server.once('error', onError); server.once('listening', onListening); server.listen(candidate, this.host);
        });
        if (bound !== undefined) { port = bound; break; }
      }
      if (port === undefined) throw new ProviderError('AUTH_TEMPORARY');
      const redirectUri = `http://${this.host}:${port}/auth/callback`;
      server.on('request', (req, res) => {
        res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('content-security-policy', "default-src 'none'");
        const u = new URL(req.url ?? '/', redirectUri);
        if (req.method !== 'GET' || u.pathname !== '/auth/callback' || u.searchParams.getAll('state').length !== 1 || u.searchParams.get('state') !== state || consumed) { res.writeHead(400); res.end('无效或已处理的回调。'); return; }
        consumed = true;
        if (u.searchParams.has('error')) { reject(new ProviderError(u.searchParams.get('error') === 'access_denied' ? 'AUTH_CANCELLED' : 'AUTH_PROTOCOL')); res.end('授权未完成，可返回 Harness。'); return; }
        const code = u.searchParams.get('code');
        if (!code || u.searchParams.getAll('code').length !== 1) { reject(new ProviderError('AUTH_PROTOCOL')); res.writeHead(400); res.end('授权响应不完整。'); return; }
        accept(code); res.end('已收到授权结果。请返回 Harness 查看验证状态。');
      });
      const url = new URL(`${ISSUER}/oauth/authorize`);
      url.search = new URLSearchParams({ response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: redirectUri, scope: CODEX_SCOPES,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state, nonce, originator: CODEX_ORIGINATOR }).toString();
      notify(url.href);
      const code = await callback; signal.throwIfAborted();
      const tokens = await this.exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      const identity = await this.verify(tokens, nonce, undefined, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
      return { tokens, identity, nonce };
    } finally {
      signal.removeEventListener('abort', abort); server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  refresh(tokens: TokenSet, signal: AbortSignal): Promise<TokenSet> {
    return this.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh }, signal, tokens);
  }
  async revoke(token: string): Promise<boolean> {
    try { const signal = AbortSignal.timeout(10000); const d = await this.discovery(signal); if (!d.revocation_endpoint) return false;
      const r = await this.transport(d.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, token, token_type_hint: 'refresh_token' }), signal, redirect: 'error' }); await r.body?.cancel(); return r.ok; } catch { return false; }
  }
}
function account(payload: Record<string, any>, prior?: string): { accountId?: string } {
  const auth = payload['https://api.openai.com/auth'];
  const value = (auth && typeof auth === 'object' ? auth.chatgpt_account_id : undefined) ?? payload.chatgpt_account_id
    ?? (Array.isArray(payload.organizations) ? payload.organizations[0]?.id : undefined);
  return typeof value === 'string' && value && value.length <= 200 ? { accountId: value } : prior ? { accountId: prior } : {};
}
