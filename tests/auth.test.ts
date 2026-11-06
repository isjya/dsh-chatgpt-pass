import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fixture, connected, expire, secret, MemoryStore } from './helpers.js';
import { Store, KEY } from '../src/auth/store.js';
import { SessionManager } from '../src/auth/session.js';
import { ProviderError, safeError } from '../src/errors.js';

describe('OAuth contract (synthetic server, actual loopback and JOSE)', () => {
  it('AUTH-01/02 initial PKCE flow and returning registration, logout preserves host', async () => {
    const f = await connected(); const first = await f.store.read();
    expect((await f.session.view()).state).toBe('connected');
    const url = f.f.lastAuthorize!;
    expect(url.searchParams.get('agent_name_hint')).toBe('DSH ChatGPT Provider');
    const form = f.f.tokenForms[0]!;
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(form.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(await f.session.logout()).toEqual({ remoteRevoked: true });
    expect((await f.store.read())?.tokens).toBeUndefined(); await f.login();
    expect(f.f.lastAuthorize!.searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(f.f.lastAuthorize!.searchParams.has('agent_name_hint')).toBe(false);
    expect(f.f.lastAuthorize!.searchParams.has('id_token_hint')).toBe(false);
    expect((await f.store.read())?.hostId).toBe(first?.hostId);
  });
  it('AUTH-03 state mismatch does not consume callback', async () => {
    const f = await fixture(); await f.login('oauth', async u => {
      const callback = new URL(u.searchParams.get('redirect_uri')!); callback.search = 'state=wrong&code=bad&client_id=evil';
      expect((await fetch(callback)).status).toBe(400);
    }); expect((await f.session.view()).state).toBe('connected');
  });
  it.each([{ nonce: 'wrong' }, { aud: 'wrong' }, { iss: 'https://evil.test' }, { azp: 'wrong' }])('AUTH-03 rejects bad claims %j', async claims => {
    const f = await fixture({ claims });
    // Override registered-claim setters in this targeted transport so claims are actually invalid.
    if ('aud' in claims || 'iss' in claims) {
      const tokens = { access: 'fake', refresh: 'fake', scopes: [], expiresAt: Date.now() + 1000, receivedAt: Date.now(), id: await new (await import('jose')).SignJWT({ nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer((claims as any).iss ?? 'https://auth.openai.com').setAudience((claims as any).aud ?? 'oaiapp_fixture').setSubject('fixture-subject').setIssuedAt().setExpirationTime('1h').sign(f.keys.privateKey) };
      await expect(f.oauth.verify(tokens, 'oaiapp_fixture', 'nonce', undefined, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    } else await expect(f.login()).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });
  it('AUTH-03 rejects signature and subject mismatch', async () => {
    const f = await connected(); const c = (await f.store.read())!;
    await expect(f.oauth.verify({ ...c.tokens!, id: c.tokens!.id!.slice(0, -8) + 'badbadba' }, c.registration!.clientId, undefined, c.registration, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(f.oauth.verify(c.tokens!, c.registration!.clientId, undefined, { ...c.registration!, subject: 'someone-else' }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });
  it('AUTH-05 identity only blocks access; explicit consent keeps issued ID', async () => {
    const f = await fixture({ scopes: 'openid profile email offline_access' }); await f.login();
    expect((await f.session.view()).state).toBe('identity_only');
    await expect(f.session.access()).rejects.toMatchObject({ code: 'SHARING_DISABLED' });
    await f.login('consent'); expect(f.f.lastAuthorize!.searchParams.get('prompt')).toBe('consent');
  });
  it('AUTH-06 pending registration survives exchange failure', async () => {
    const f = await fixture({ noRefresh: true }); await expect(f.login()).rejects.toMatchObject({ code: 'AUTH_PROTOCOL' });
    const c = (await f.store.read())!; expect(c.registration?.clientId).toBe('oaiapp_fixture'); expect(c.state).toBe('disconnected');
    expect(c.registration?.subject).toBeUndefined();
  });
  it('AUTH-07/08 ten concurrent refreshes rotate once, with two managers sharing atomic store', async () => {
    const f = await connected(); await expire(f.store); const second = new SessionManager(f.store, f.oauth);
    const values = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? f.session : second).access()));
    expect(f.f.refreshCount).toBe(1); expect(new Set(values.map(v => v.token)).size).toBe(1); expect(values[0]!.token).toContain('_1');
  });
  it('AUTH-09/12 saves rotated checkpoint on JWKS outage and recovers after manager restart', async () => {
    const f = await connected(); await expire(f.store); f.f.jwksOk = false;
    await expect(f.session.access()).rejects.toMatchObject({ code: 'AUTH_TEMPORARY' });
    expect((await f.store.read())?.checkpoint?.tokens.refresh).toContain('_1');
    f.f.jwksOk = true; const next = new SessionManager(f.store, f.oauth); await next.access();
    expect(f.f.refreshCount).toBe(1); expect((await f.store.read())?.checkpoint).toBeUndefined();
  });
  it('AUTH-09 code exchange checkpoint survives verification outage', async () => {
    const f = await fixture(); f.f.jwksOk = false;
    await expect(f.login()).rejects.toMatchObject({ code: 'AUTH_TEMPORARY' });
    f.f.jwksOk = true; const next = new SessionManager(f.store, f.oauth); await next.recover();
    expect((await next.view()).state).toBe('connected'); expect(f.f.exchangeCount).toBe(1);
  });
  it('AUTH-10 terminal refresh removes unusable tokens, retains registration', async () => {
    const f = await connected(); await expire(f.store); f.f.terminal = true;
    await expect(f.session.access()).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    const c = (await f.store.read())!; expect(c.state).toBe('reauth_required'); expect(c.tokens).toBeUndefined(); expect(c.registration?.subject).toBeTruthy();
  });
  it('AUTH-11 logout wins over late refresh and invalidates prepared binding', async () => {
    const f = await connected(); const binding = await f.session.binding(); await expire(f.store);
    let release!: () => void; f.f.waitRefresh = new Promise<void>(r => { release = r; });
    const refreshing = f.session.access().catch(e => e);
    while (!f.f.refreshCount) await new Promise(r => setTimeout(r, 1));
    const out = f.session.logout(); release(); await refreshing; await out;
    expect((await f.store.read())?.state).toBe('disconnected'); await expect(f.session.access(binding)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('AUTH-04/11/16 cancel closes callback port and prevents late activation', async () => {
    const f = await fixture(), cancel = new AbortController(); let url!: URL;
    let ready!: () => void; const shown = new Promise<void>(r => { ready = r; });
    const login = f.session.login({ method: 'oauth', signal: cancel.signal, commit: async () => {}, prompt: async () => '', notify: n => { url = new URL(n.url!); ready(); } });
    await shown; cancel.abort(); await expect(login).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    await expect(fetch(url.searchParams.get('redirect_uri')!)).rejects.toThrow(); expect((await f.session.view()).state).toBe('disconnected');
  });
  it('AUTH-11 cancellation after exchange removes the pending checkpoint, so restart cannot activate it', async () => {
    const f = await fixture(), cancel = new AbortController();
    const verify = f.oauth.verify.bind(f.oauth); let release!: () => void, entered!: () => void;
    const reached = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    f.oauth.verify = async (...args) => { entered(); await gate; return verify(...args); };
    const jobs: Promise<unknown>[] = [];
    const login = f.session.login({ method: 'oauth', signal: cancel.signal, commit: async () => {}, prompt: async () => '', notify: n => {
      const u = new URL(n.url!); f.f.nonce = u.searchParams.get('nonce')!; const callback = new URL(u.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ code: 'fixture', state: u.searchParams.get('state')!, client_id: 'oaiapp_fixture' }).toString(); jobs.push(fetch(callback));
    } });
    await reached; expect((await f.store.read())?.checkpoint).toBeTruthy(); cancel.abort(); release();
    await expect(login).rejects.toMatchObject({ code: 'AUTH_CANCELLED' }); await Promise.all(jobs);
    expect((await f.store.read())?.checkpoint).toBeUndefined(); const restarted = new SessionManager(f.store, f.oauth); await restarted.recover(); expect((await restarted.view()).state).toBe('disconnected');
  });
  it('AUTH-04 controlled login deadline closes the callback without activation', async () => {
    const f = await fixture(); const session = new SessionManager(f.store, f.oauth, () => {}, Date.now, 25); let callback: string | undefined;
    await expect(session.login({ method: 'oauth', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: n => { callback = new URL(n.url!).searchParams.get('redirect_uri')!; } })).rejects.toMatchObject({ code: 'AUTH_CANCELLED' });
    expect(callback).toBeTruthy(); await expect(fetch(callback!)).rejects.toThrow(); expect((await session.view()).state).toBe('disconnected');
  });
  it('AUTH-11 observing another process logout aborts already active network signals', async () => {
    const f = await connected(); await f.session.access(); const signal = f.session.signal;
    const other = new SessionManager(f.store, f.oauth); await other.logout(); await f.session.observe();
    expect(signal.aborted).toBe(true);
  });
  it('AUTH-13 revocation outage still clears local tokens with accurate outcome', async () => {
    const f = await connected(); f.f.revokeOk = false;
    expect(await f.session.logout()).toEqual({ remoteRevoked: false }); expect((await f.store.read())?.tokens).toBeUndefined();
  });
  it('AUTH-14 redacts views and unknown errors including cause', async () => {
    const f = await connected(); f.session.report(new Error(secret, { cause: new Error(secret) }));
    const serialized = JSON.stringify([await f.session.view(), safeError(new Error(secret)), new ProviderError(secret, 403, secret + ':', secret + ':')]);
    expect(serialized).not.toContain(secret); expect(serialized).not.toContain('fixture-subject'); expect(serialized).not.toContain('oaiapp_fixture');
  });
  it('AUTH-15 unknown schema, corruption and read-only failure preserve originals; undefined is not delete', async () => {
    const memory = new MemoryStore(), store = new Store(memory); await store.update(() => {});
    const original = structuredClone(memory.record); await memory.modifyRecord(KEY, async () => undefined); expect(memory.record).toEqual(original);
    memory.record = { kind: 'grant', payload: { schemaVersion: 99 } };
    await expect(store.update(() => {})).rejects.toMatchObject({ code: 'STORAGE_INVALID' }); expect(memory.record.payload).toEqual({ schemaVersion: 99 });
    const readonly = new Store({ readRecord: async () => undefined, modifyRecord: async () => { throw new Error('Read only'); } });
    await expect(readonly.update(() => {})).rejects.toThrow('Read only');
  });
});
