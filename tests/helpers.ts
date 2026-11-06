import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { expect } from 'vitest';
import { OAuth, SCOPES, ISSUER, RESOURCE } from '../src/auth/oauth.js';
import { Store, KEY, type Connection, type CredentialStore } from '../src/auth/store.js';
import { SessionManager } from '../src/auth/session.js';
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials';

export class MemoryStore implements CredentialStore {
  record?: CredentialRecord;
  tail: Promise<unknown> = Promise.resolve();
  async readRecord() { await this.tail; return structuredClone(this.record); }
  modifyRecord(_key: any, fn: (c: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    const operation = this.tail.then(async () => { const next = await fn(structuredClone(this.record)); if (next !== undefined) this.record = structuredClone(next); return structuredClone(this.record); });
    this.tail = operation.catch(() => {}); return operation;
  }
}
export const secret = 'SYNTHETIC_SECRET_DO_NOT_EXPOSE';
export async function fixture(options: { scopes?: string; claims?: Record<string, any>; noRefresh?: boolean } = {}) {
  const keys = await generateKeyPair('RS256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const memory = new MemoryStore(); const store = new Store(memory);
  const f = { scopes: options.scopes ?? SCOPES, claims: options.claims ?? {}, nonce: '', refreshCount: 0, exchangeCount: 0, revokeOk: true, jwksOk: true, terminal: false, waitRefresh: undefined as Promise<void> | undefined,
    tokenForms: [] as URLSearchParams[], callbacks: [] as string[], lastAuthorize: undefined as URL | undefined };
  const transport: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (u.endsWith('/jwks')) { if (!f.jwksOk) return new Response('', { status: 503 }); return Response.json({ keys: [jwk] }); }
    if (u.endsWith('/revoke')) return new Response('', { status: f.revokeOk ? 200 : 503 });
    if (u.endsWith('/token')) {
      const form = new URLSearchParams(init?.body as URLSearchParams); f.tokenForms.push(form);
      expect(form.get('client_id')).toBe('oaiapp_fixture'); expect(form.get('resource')).toBe(RESOURCE);
      const refresh = form.get('grant_type') === 'refresh_token';
      if (refresh) { f.refreshCount++; expect(form.has('scope')).toBe(false); await f.waitRefresh; if (f.terminal) return Response.json({ error: 'invalid_grant', error_description: secret }, { status: 400 }); }
      else f.exchangeCount++;
      const id = await new SignJWT({ ...(refresh ? {} : { nonce: f.nonce }), email: 'fixture@example.test', ...f.claims }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(ISSUER).setAudience('oaiapp_fixture').setSubject('fixture-subject').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({ access_token: `${secret}_access_${f.refreshCount}`, refresh_token: options.noRefresh ? undefined : `${secret}_refresh_${f.refreshCount}`, id_token: id, token_type: 'Bearer', expires_in: 3600, scope: f.scopes });
    }
    throw new Error('Unexpected fake endpoint');
  };
  const oauth = new OAuth(transport), session = new SessionManager(store, oauth);
  const login = async (method = 'oauth', before?: (url: URL) => Promise<void>) => {
    const controller = new AbortController(); const jobs: Promise<unknown>[] = [];
    const result = session.login({ method, signal: controller.signal, commit: async () => {}, prompt: async () => '', notify: notice => {
      const u = new URL(notice.url!); f.lastAuthorize = u; f.nonce = u.searchParams.get('nonce')!;
      jobs.push((async () => {
        await before?.(u);
        const callback = new URL(u.searchParams.get('redirect_uri')!); callback.search = new URLSearchParams({ state: u.searchParams.get('state')!, code: 'fixture_code', ...(u.searchParams.get('client_id') === 'dynamic_agent_client' ? { client_id: 'oaiapp_fixture' } : {}) }).toString();
        const response = await fetch(callback); f.callbacks.push(String(response.status));
      })());
    } });
    try { await result; } finally { await Promise.all(jobs); }
  };
  return { ...f, f, memory, store, oauth, session, login, keys, transport };
}
export async function connected() { const f = await fixture(); await f.login(); return f; }
export async function expire(store: Store) { await store.update(c => { c.tokens!.expiresAt = 1; }); }
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const v of it) out.push(v); return out; }
export function events(values: any[]): AsyncIterable<any> { return { async *[Symbol.asyncIterator]() { yield* values; } }; }
export function message(text = '你好，世界', phase = 'final_answer') { return { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] }; }
export function scripted(output: any[], deltas = true) {
  const list: any[] = [];
  output.forEach((item, index) => {
    list.push({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : item.type === 'function_call' ? { arguments: '' } : {}) } });
    if (deltas && item.type === 'message') list.push({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: item.content[0].text });
    list.push({ type: 'response.output_item.done', output_index: index, item });
  });
  list.push({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 38 } } });
  return list;
}
export function sse(values: any[], split = 7): Response {
  const bytes = new TextEncoder().encode(values.map(v => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let n = 0; n < bytes.length; n += split) controller.enqueue(bytes.slice(n, n + split)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
