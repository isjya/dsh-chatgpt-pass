import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { ProviderError, object } from '../errors.js';
import type { Connection, TokenSet } from './store.js';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export type Fetch = typeof fetch;
export interface Identity { subject: string; issuer: string; email?: string }
export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string }
export async function json(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('PROTOCOL');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) throw new ProviderError('PROTOCOL'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) { if (e instanceof ProviderError) throw e; throw new ProviderError('PROTOCOL'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class OAuth {
  private discoveryPromise?: Promise<Discovery>;
  constructor(readonly transport: Fetch = fetch, readonly now = Date.now) {}
  private endpoint(value: unknown): string {
    if (typeof value !== 'string') throw new ProviderError('AUTH_PROTOCOL');
    let u: URL;
    try { u = new URL(value); } catch { throw new ProviderError('AUTH_PROTOCOL'); }
    if (u.origin !== ISSUER || u.username || u.password || u.hash || u.search) throw new ProviderError('AUTH_PROTOCOL');
    return u.href;
  }
  async discovery(signal: AbortSignal): Promise<Discovery> {
    this.discoveryPromise ??= (async () => {
      const r = await this.transport(`${ISSUER}/.well-known/openid-configuration`, { signal, redirect: 'error' });
      if (!r.ok) throw new ProviderError('AUTH_TEMPORARY');
      const d = object(await json(r));
      if (d.issuer !== ISSUER) throw new ProviderError('AUTH_PROTOCOL');
      return { issuer: ISSUER, authorization_endpoint: this.endpoint(d.authorization_endpoint), token_endpoint: this.endpoint(d.token_endpoint), jwks_uri: this.endpoint(d.jwks_uri), revocation_endpoint: this.endpoint(d.revocation_endpoint) };
    })().catch(e => { this.discoveryPromise = undefined; throw e instanceof ProviderError ? e : new ProviderError('AUTH_TEMPORARY'); });
    return this.discoveryPromise;
  }
  async exchange(fields: Record<string, string>, signal: AbortSignal): Promise<TokenSet> {
    const d = await this.discovery(signal);
    let r: Response;
    try { r = await this.transport(d.token_endpoint, { method: 'POST', body: new URLSearchParams({ ...fields, resource: RESOURCE }), signal, redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); }
    catch { signal.throwIfAborted(); throw new ProviderError('AUTH_TEMPORARY'); }
    const t = object(await json(r));
    if (!r.ok) {
      const code = t.error;
      if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client'].includes(code)) throw new ProviderError('AUTH_INVALID', r.status);
      throw new ProviderError('AUTH_TEMPORARY', r.status);
    }
    if (String(t.token_type).toLowerCase() !== 'bearer' || typeof t.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(t.access_token)
      || typeof t.refresh_token !== 'string' || !t.refresh_token || typeof t.scope !== 'string' || typeof t.expires_in !== 'number' || !Number.isFinite(t.expires_in) || t.expires_in <= 0
      || (t.id_token !== undefined && typeof t.id_token !== 'string')) throw new ProviderError('AUTH_PROTOCOL');
    const receivedAt = this.now();
    if (!Number.isFinite(receivedAt + t.expires_in * 1000)) throw new ProviderError('AUTH_PROTOCOL');
    return { access: t.access_token, refresh: t.refresh_token, id: t.id_token, scopes: t.scope.split(/\s+/).filter(Boolean), receivedAt, expiresAt: receivedAt + t.expires_in * 1000,
      earliestRefreshAt: typeof t.earliest_refresh_at === 'number' && Number.isFinite(t.earliest_refresh_at) ? t.earliest_refresh_at * 1000 : undefined };
  }
  async verify(tokens: TokenSet, clientId: string, nonce: string | undefined, prior: Connection['registration'], signal: AbortSignal): Promise<Identity> {
    if (!tokens.id) {
      if (nonce || !prior?.subject || prior.issuer !== ISSUER) throw new ProviderError('AUTH_INVALID');
      return { subject: prior.subject, issuer: ISSUER, email: prior.email };
    }
    const d = await this.discovery(signal);
    const keys = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 5000, [customFetch]: (url, init) => this.transport(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: 'error' }) });
    try {
      const { payload } = await jwtVerify(tokens.id, keys, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], clockTolerance: 30, currentDate: new Date(this.now()), requiredClaims: ['exp', 'iat', 'sub'] });
      if (signal.aborted) throw new ProviderError('AUTH_CANCELLED');
      if (!payload.sub || typeof payload.iat !== 'number' || payload.iat > this.now() / 1000 + 30 || (nonce !== undefined && payload.nonce !== nonce)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) || (payload.azp !== undefined && payload.azp !== clientId)
        || (prior?.subject && (prior.subject !== payload.sub || prior.issuer !== payload.iss))) throw new ProviderError('AUTH_INVALID');
      return { subject: payload.sub, issuer: ISSUER, email: typeof payload.email === 'string' ? payload.email : prior?.email };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const code = e && typeof e === 'object' ? Reflect.get(e, 'code') : undefined;
      if (typeof code === 'string' && (code.startsWith('ERR_JWT') || code.startsWith('ERR_JWS') || code === 'ERR_JOSE_ALG_NOT_ALLOWED' || code === 'ERR_JWKS_NO_MATCHING_KEY')) throw new ProviderError('AUTH_INVALID');
      throw new ProviderError('AUTH_TEMPORARY');
    }
  }
  async revoke(clientId: string, token: string): Promise<boolean> {
    try { const signal = AbortSignal.timeout(10000); const d = await this.discovery(signal); const r = await this.transport(d.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ client_id: clientId, token, token_type_hint: 'refresh_token' }), signal, redirect: 'error' }); await r.body?.cancel(); return r.ok; } catch { return false; }
  }
  async authorize(c: Connection, consent: boolean, signal: AbortSignal, notify: (url: string) => void, pending: (clientId: string) => Promise<void>): Promise<{ tokens: TokenSet; nonce: string; clientId: string }> {
    const d = await this.discovery(signal);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const server = createServer();
    let consumed = false;
    let accept!: (v: { code: string; clientId: string }) => void, reject!: (e: unknown) => void;
    const callback = new Promise<{ code: string; clientId: string }>((a, b) => { accept = a; reject = b; });
    // A callback rejection can precede the await while the browser notice is delivered.
    void callback.catch(() => {});
    const abort = () => reject(new ProviderError('AUTH_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); resolve(); }); });
      const address = server.address(); if (!address || typeof address === 'string') throw new ProviderError('AUTH_PROTOCOL');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      server.on('request', (req, res) => {
        res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('content-security-policy', "default-src 'none'");
        const u = new URL(req.url ?? '/', redirectUri);
        if (req.method !== 'GET' || u.pathname !== '/auth/callback' || u.searchParams.getAll('state').length !== 1 || u.searchParams.get('state') !== state || consumed) { res.writeHead(400); res.end('无效或已处理的回调。'); return; }
        consumed = true;
        const issued = u.searchParams.get('client_id') ?? c.registration?.clientId;
        if (u.searchParams.has('error')) { reject(new ProviderError('AUTH_CANCELLED')); res.end('授权未完成，可返回 Harness。'); return; }
        const code = u.searchParams.get('code');
        if (!code || !issued || issued === 'dynamic_agent_client' || issued.length > 256 || (c.registration && issued !== c.registration.clientId)
          || ['code', 'client_id', 'error'].some(k => u.searchParams.getAll(k).length > 1)) { reject(new ProviderError('AUTH_PROTOCOL')); res.writeHead(400); res.end('授权响应不完整。'); return; }
        accept({ code, clientId: issued }); res.end('已收到授权结果。请返回 Harness 查看验证状态。');
      });
      const url = new URL(d.authorization_endpoint);
      const params: Record<string, string> = { client_id: c.registration?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: c.hostId, response_type: 'code', redirect_uri: redirectUri,
        scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
      if (!c.registration) params.agent_name_hint = 'DSH ChatGPT Provider';
      if (c.tokens?.id) params.id_token_hint = c.tokens.id;
      if (consent) params.prompt = 'consent';
      url.search = new URLSearchParams(params).toString(); notify(url.href);
      const result = await callback; signal.throwIfAborted();
      await pending(result.clientId);
      const tokens = await this.exchange({ grant_type: 'authorization_code', client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: redirectUri }, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      return { tokens, nonce, clientId: result.clientId };
    } finally {
      signal.removeEventListener('abort', abort); server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}
