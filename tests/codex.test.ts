import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { zstdDecompressSync } from 'node:zlib';
import { MemoryStore } from './helpers.js';
import { Store } from '../src/auth/store.js';
import { SessionManager } from '../src/auth/session.js';
import { OAuth, ISSUER } from '../src/auth/oauth.js';
import { CodexOAuth, CODEX_BASE, CODEX_CLIENT_ID } from '../src/auth/codex.js';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { PROVIDER, toolName } from '../src/llm/request.js';
import { wireError } from '../src/errors.js';
import { mapUsage } from '../src/llm/usage.js';
import { collect, connected, events, scripted, message, sse } from './helpers.js';
import { translate } from '../src/llm/stream.js';

const tokens = () => ({ access: 'codex-access', refresh: 'codex-refresh', scopes: ['openid', 'profile', 'email', 'offline_access'], receivedAt: Date.now(), expiresAt: Date.now() + 3600_000 });
const identity = { subject: 'codex-subject', issuer: ISSUER, email: 'business@example.test', accountId: 'acct_fixture' };

async function codexKeys() {
  const keys = await generateKeyPair('RS256');
  return { keys, jwk: { ...await exportJWK(keys.publicKey), kid: 'codex-fixture', alg: 'RS256', use: 'sig' } };
}

describe('Codex (Business) path', () => {
  it('CODEX-AUTH-01 authorize URL shape, loopback callback, token exchange and ID token verification', async () => {
    const { keys, jwk } = await codexKeys();
    let nonce = '';
    const transport: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
      if (u.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      if (u.endsWith('/oauth/token')) {
        const form = new URLSearchParams(init?.body as URLSearchParams);
        expect(form.get('client_id')).toBe(CODEX_CLIENT_ID);
        expect(form.has('resource')).toBe(false);
        expect(form.get('grant_type')).toBe('authorization_code');
        const id = await new SignJWT({ nonce, email: identity.email, 'https://api.openai.com/auth': { chatgpt_account_id: identity.accountId } })
          .setProtectedHeader({ alg: 'RS256', kid: 'codex-fixture' }).setIssuer(ISSUER).setAudience(CODEX_CLIENT_ID).setSubject(identity.subject).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
        return Response.json({ access_token: 'codex-access', refresh_token: 'codex-refresh', id_token: id, token_type: 'Bearer', expires_in: 864000, scope: 'openid profile email offline_access' });
      }
      throw new Error(`unexpected ${u}`);
    };
    const oauth = new CodexOAuth(transport, Date.now, [0]);
    const controller = new AbortController();
    const result = await oauth.authorize(controller.signal, url => {
      const authorize = new URL(url);
      expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/oauth/authorize`);
      expect(authorize.searchParams.get('client_id')).toBe(CODEX_CLIENT_ID);
      expect(authorize.searchParams.get('scope')).toBe('openid profile email offline_access');
      expect(authorize.searchParams.get('codex_cli_simplified_flow')).toBe('true');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      nonce = authorize.searchParams.get('nonce')!;
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('localhost');
      expect(callback.pathname).toBe('/auth/callback');
      callback.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'fixture_code' }).toString();
      void fetch(callback);
    });
    expect(result.tokens.access).toBe('codex-access');
    expect(result.identity).toMatchObject({ subject: identity.subject, accountId: identity.accountId, email: identity.email });
  });

  it('CODEX-AUTH-02 session stores a codex connection, refreshes it and keeps identity', async () => {
    const memory = new MemoryStore(); const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    let refreshes = 0;
    session.codex = {
      authorize: async () => ({ tokens: tokens(), identity, nonce: 'nonce' }),
      verify: async () => identity,
      refresh: async () => { refreshes++; return { ...tokens(), access: 'codex-access-2' }; },
      revoke: async () => true,
    } as unknown as CodexOAuth;
    const controller = new AbortController();
    await session.login({ method: 'codex', signal: controller.signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    expect((await session.view())).toMatchObject({ state: 'connected', method: 'codex' });
    expect(await session.profile()).toEqual({ method: 'codex', accountId: identity.accountId });
    await session.store.update(c => { c.tokens!.expiresAt = 1; });
    const access = await session.access();
    expect(access.token).toBe('codex-access-2'); expect(refreshes).toBe(1);
    expect((await session.view()).method).toBe('codex');
    await expect(session.logout()).resolves.toEqual({ remoteRevoked: true });
    expect((await session.view()).state).toBe('disconnected');
  });

  it('CODEX-LLM-01 codex catalog and responses use the codex base URL and account header', async () => {
    const memory = new MemoryStore(); const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    const seen: { url: string; headers: Headers; body?: any }[] = [];
    const adapter = new ChatGPTAdapter(session, async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init!.headers), body: init!.body ? JSON.parse(String(init!.body)) : undefined });
      if (String(url).includes('/models')) return Response.json({ models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', context_window: 272000,
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'high', description: 'Deep' }], default_reasoning_level: 'low' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
      ] });
      return sse(scripted([message()]));
    });
    const catalog = await adapter.listModels();
    expect(catalog.map(m => m.id)).toEqual(['gpt-5.6-sol']);
    expect(catalog[0]).toMatchObject({ context: { contextWindow: 272000 },
      reasoning: { efforts: [{ id: 'low', name: 'Low', description: 'Fast' }, { id: 'high', name: 'High', description: 'Deep' }], defaultEffort: 'low' } });
    expect(seen[0]!.url).toBe(`${CODEX_BASE}/models?client_version=1.0.0`);
    expect(seen[0]!.headers.get('chatgpt-account-id')).toBe(identity.accountId);
    expect(seen[0]!.headers.get('originator')).toBe('dsh-chatgpt-pass');

    const chunks = await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-5.6-sol', reasoningEffort: 'high' as any,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }));
    const response = seen.find(s => s.url.endsWith('/responses'))!;
    expect(response.url).toBe(`${CODEX_BASE}/responses`);
    expect(response.headers.get('chatgpt-account-id')).toBe(identity.accountId);
    expect(response.body).toMatchObject({ model: 'gpt-5.6-sol', store: false, stream: true, include: ['reasoning.encrypted_content'], reasoning: { effort: 'high' } });
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } });
  });

  it('CODEX-STORE-01 migrates a legacy SIWC record without losing it', async () => {
    const memory = new MemoryStore();
    memory.record = { kind: 'grant', payload: { schemaVersion: 1, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', generation: 3, state: 'disconnected' } } as any;
    const store = new Store(memory);
    expect(await store.read()).toMatchObject({ schemaVersion: 2, method: 'siwc', generation: 3, state: 'disconnected' });
    await store.update(c => { c.generation++; });
    expect((memory.record as any).payload).toMatchObject({ schemaVersion: 2, method: 'siwc', generation: 4 });
  });

  it('CODEX-ERR-01 usage_limit_reached keeps its code and a clear message', () => {
    const error = wireError({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'team' } }, 429);
    expect(error.code).toBe('usage_limit_reached');
    expect(error.message).toContain('上限');
    expect(error.diagnostic.status).toBe(429);
  });

  it('CODEX-LLM-02 compresses large codex request bodies with zstd', async () => {
    const memory = new MemoryStore();
    const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    let compressed: Uint8Array | undefined; let encoding: string | null = null;
    const adapter = new ChatGPTAdapter(session, async (url, init) => {
      if (String(url).includes('/models')) return Response.json({ models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' }] });
      encoding = new Headers(init!.headers).get('content-encoding'); compressed = init!.body as Uint8Array;
      return sse(scripted([message()]));
    });
    await collect(adapter.stream({ provider: PROVIDER, model: 'gpt-5.6-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }] }] }));
    expect(encoding).toBe('zstd');
    const body = JSON.parse(zstdDecompressSync(compressed as any).toString());
    expect(body).toMatchObject({ model: 'gpt-5.6-sol', store: false, stream: true });
  });

  it('CODEX-SEC-01 view never exposes tokens or subject; profile carries only method and account id', async () => {
    const memory = new MemoryStore();
    const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    const view = JSON.stringify(await session.view());
    expect(view).not.toContain('codex-access');
    expect(view).not.toContain('codex-refresh');
    expect(view).not.toContain(identity.subject);
    expect(view).not.toContain(identity.accountId);
    expect(view).not.toContain('business@example.test');
    expect(await session.profile()).toEqual({ method: 'codex', accountId: identity.accountId });
  });

  it('CODEX-SWITCH-01 SIWC login after a Codex connection starts a fresh dynamic registration', async () => {
    const memory = new MemoryStore(); const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    const siwcTokens = { access: 'siwc-access', refresh: 'siwc-refresh', scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'], receivedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
    let seen: any;
    session.oauth = {
      authorize: async (c: any, _consent: any, _signal: any, _notify: any, pending: any) => { seen = c; await pending('oaiapp_switch'); return { tokens: siwcTokens, nonce: 'n2', clientId: 'oaiapp_switch' }; },
      verify: async () => ({ subject: 'siwc-subject', issuer: ISSUER, email: 'siwc@example.test' }),
    } as unknown as OAuth;
    await session.login({ method: 'oauth', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    expect(seen.method).toBe('siwc');
    expect(seen.registration).toBeUndefined();
    expect(seen.tokens).toBeUndefined();
    expect(await session.view()).toMatchObject({ state: 'connected', method: 'siwc' });
    expect(await session.profile()).toEqual({ method: 'siwc' });
  });

  it('CODEX-SWITCH-02 Codex login after an SIWC connection replaces method and registration', async () => {
    const f = await connected();
    f.session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await f.session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    expect(await f.session.view()).toMatchObject({ state: 'connected', method: 'codex' });
    expect(await f.session.profile()).toEqual({ method: 'codex', accountId: identity.accountId });
    expect((await f.session.access()).token).toBe('codex-access');
  });

  it('CODEX-STREAM-01 accepts Codex completed events with empty output after streamed items', async () => {
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
    const text = [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: msg },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
    ];
    const chunks = await collect(translate(events(text), 'gpt-5.6-sol', 'identity', new Map(), AbortSignal.timeout(5000)));
    expect(chunks.filter(c => c.type === 'text-delta').map((c: any) => c.text).join('')).toBe('ok');
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } });

    const call = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', namespace: 'dsh', name: toolName('probe_echo'), arguments: '{}' };
    const tool = [
      { type: 'response.output_item.added', output_index: 0, item: { ...call, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
    ];
    const toolChunks = await collect(translate(events(tool), 'gpt-5.6-sol', 'identity', new Map([[toolName('probe_echo'), 'probe_echo']]), AbortSignal.timeout(5000)));
    expect(toolChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } });
  });

  it('CODEX-STREAM-02 rejects completed with empty output and no streamed items', async () => {
    await expect(collect(translate(events([{ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }]),
      'gpt-5.6-sol', 'identity', new Map(), AbortSignal.timeout(5000)))).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('CODEX-USAGE-01 maps 5h/weekly windows and drops account PII', () => {
    const now = 1_794_000_000_000;
    const body = {
      user_id: 'user_secret', account_id: 'account_secret', email: 'secret@example.test', plan_type: 'team',
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 16, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.floor(now / 1000) + 3600 },
        secondary_window: { used_percent: 42.4, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: Math.floor(now / 1000) + 86400 },
      },
      credits: { has_credits: false }, model_usage: { secret: 1 },
    };
    const usage = mapUsage(body, now);
    expect(usage).toMatchObject({
      plan: 'team', limitReached: false, observedAt: now,
      windows: [
        { id: '5h', label: '5 小时窗口', usedPercent: 16, windowSeconds: 18000, resetAt: (Math.floor(now / 1000) + 3600) * 1000 },
        { id: 'weekly', label: '每周窗口', usedPercent: 42.4, windowSeconds: 604800, resetAt: (Math.floor(now / 1000) + 86400) * 1000 },
      ],
    });
    const json = JSON.stringify(usage);
    expect(json).not.toContain('user_secret');
    expect(json).not.toContain('account_secret');
    expect(json).not.toContain('secret@example.test');
    expect(json).not.toContain('credits');
  });

  it('CODEX-USAGE-02 rejects a payload without usable windows', () => {
    expect(() => mapUsage({ plan_type: 'team', rate_limit: { limit_reached: false } }, Date.now())).toThrow();
    expect(() => mapUsage({ rate_limit: { primary_window: { used_percent: 150 } } }, Date.now())).toThrow();
  });

  it('CODEX-USAGE-03 adapter fetches /usage with account headers; SIWC returns no usage', async () => {
    const memory = new MemoryStore();
    const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    const seen: { url: string; headers: Headers }[] = [];
    const adapter = new ChatGPTAdapter(session, async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init!.headers) });
      return Response.json({ plan_type: 'team', rate_limit: { limit_reached: false,
        primary_window: { used_percent: 16, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 42, limit_window_seconds: 604800, reset_after_seconds: 86400 } } });
    });
    const usage = await adapter.usage();
    expect(seen[0]!.url).toBe(`${CODEX_BASE}/usage`);
    expect(seen[0]!.headers.get('chatgpt-account-id')).toBe(identity.accountId);
    expect(usage?.windows.map(w => w.id)).toEqual(['5h', 'weekly']);
    const f = await connected();
    const siwc = new ChatGPTAdapter(f.session, async () => { throw new Error('must not fetch usage for SIWC'); });
    expect(await siwc.usage()).toBeUndefined();
  });

  it('CODEX-AGENT-01 Harness Agent executes two read-only tools through the Codex transport', async () => {
    const memory = new MemoryStore();
    const session = new SessionManager(new Store(memory), new OAuth(async () => { throw new Error('unused'); }), () => {});
    session.codex = { authorize: async () => ({ tokens: tokens(), identity, nonce: 'n' }), verify: async () => identity, refresh: async () => tokens(), revoke: async () => true } as unknown as CodexOAuth;
    await session.login({ method: 'codex', signal: new AbortController().signal, commit: async () => {}, prompt: async () => '', notify: () => {} } as any);
    const ctx = new Context(); const requests: any[] = []; const executed: string[] = [];
    try {
      await mountAgentLoopTestDependencies(ctx);
      const adapter = new ChatGPTAdapter(session, async (url, init) => {
        if (String(url).includes('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
        expect(String(url)).toBe(`${CODEX_BASE}/responses`);
        requests.push(JSON.parse(String(init!.body)));
        if (requests.length === 1) return sse(scripted(['echo', 'clock'].map((name, n) => ({ type: 'function_call', id: `item_${n}`, call_id: `original_call_${n}`, name: toolName(name), namespace: 'dsh', arguments: '{}', status: 'completed' }))));
        return sse(scripted([message('codex tools finished')]));
      });
      ctx.llm.registerAdapter([PROVIDER], adapter);
      for (const name of ['echo', 'clock']) ctx.tools.register(defineContentToolFixture({ name, description: 'Read-only fixture tool', parameters: {}, isConcurrencySafe: () => true, async execute() { executed.push(name); return [{ type: 'text', text: `fixture:${name}` }]; } }));
      const loop = await mountAgentLoopTestHarness(ctx);
      const agent = await loop.create(SessionId('codex-synthetic-tools'), { provider: PROVIDER, model: 'fixture-model' });
      const idle = new Promise<void>(resolve => { const dispose = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { dispose(); resolve(); } }); });
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run two read-only tools.' }] }));
      await idle;
      expect(executed.sort()).toEqual(['clock', 'echo']);
      expect(requests).toHaveLength(2);
      expect(requests[1].input.filter((i: any) => i.type === 'function_call_output').map((i: any) => i.call_id)).toEqual(['original_call_0', 'original_call_1']);
      expect(requests[0].tools?.[0]).toMatchObject({ type: 'namespace', name: 'dsh' });
    } finally { await ctx.fiber.dispose(); }
  });
});
