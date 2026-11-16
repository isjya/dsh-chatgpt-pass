import { afterEach, expect, it, vi } from 'vitest';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { DEFAULT_RECOVERY, recoveryDelay, retryAfter } from '../src/llm/recovery.js';
import { PROVIDER, toolName } from '../src/llm/request.js';
import { collect, connected, message, scripted, secret, sse } from './helpers.js';

const options = { provider: PROVIDER, model: 'fixture-model', messages: [] };
const fast = { ...DEFAULT_RECOVERY, initialDelayMs: 1, jitterRatio: 0 };
const catalog = () => Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
afterEach(() => vi.useRealTimers());

it.each([408, 500, 502, 503, 504, 'connection', 'EOF', 'rate_limit'] as const)('recovers %s before output using a fresh attempt and the same request', async kind => {
  const f = await connected(), bodies: string[] = [], signals: AbortSignal[] = [];
  const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
    if (String(url).endsWith('/models')) return catalog();
    bodies.push(String(init!.body)); signals.push(init!.signal!);
    if (bodies.length < 3) {
      if (kind === 'connection') throw new TypeError('fetch failed');
      if (kind === 'EOF') return sse([]);
      if (kind === 'rate_limit') return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 });
      return Response.json({ error: { message: secret } }, { status: kind });
    }
    return sse(scripted([message('recovered')]));
  }, Date.now, undefined, fast);
  try {
    const chunks = await collect(adapter.stream(options));
    expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1);
    expect(new Set(signals).size).toBe(3); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(chunks.filter(c => c.type === 'finish')).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } });
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('stops after two retries with the original safe error and retry count', async () => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++; return Response.json({ error: { message: secret } }, { status: 503 });
  }, Date.now, undefined, fast);
  try {
    const failure = await collect(adapter.stream(options)).catch(error => error);
    expect(failure).toMatchObject({ code: 'HTTP_503', diagnostic: { retryCount: 2 }, message: expect.stringContaining('已自动重试 2 次') });
    expect(JSON.stringify(failure)).not.toContain(secret); expect(posts).toBe(3);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it.each([
  [400, 'invalid_request_error'], [401, 'unknown'], [403, 'unknown'], [429, 'usage_limit_reached'],
  [429, 'subscription_sharing_usage_limit_exceeded'], [429, 'unknown'], [400, 'context_length_exceeded'],
  [401, 'server_error'], [403, 'rate_limit_exceeded'], [400, 'server_error'],
] as const)('does not retry permanent HTTP %s / %s', async (status, code) => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++; return Response.json({ error: { code, message: secret } }, { status });
  }, Date.now, undefined, fast);
  try { await expect(collect(adapter.stream(options))).rejects.toThrow(); expect(posts).toBe(1); }
  finally { adapter.dispose(); f.session.dispose(); }
});

it.each(['text', 'reasoning', 'tool', 'incomplete', 'protocol', 'json'] as const)('does not replay %s failures or splice partial output', async kind => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++;
    if (kind === 'json') return new Response('event: response.created\ndata: {invalid\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (kind === 'text') return sse(scripted([message('partial')]).slice(0, -1));
    if (kind === 'incomplete') return sse([{ type: 'response.incomplete' }]);
    if (kind === 'protocol') return sse([{ type: 'response.output_item.added', output_index: 0, item: { type: 'unknown' } }]);
    if (kind === 'reasoning') return sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'partial' },
    ]);
    return sse([{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'call_fixture', name: toolName('echo'), arguments: '' } }]);
  }, Date.now, undefined, fast);
  try {
    const chunks: unknown[] = [];
    await expect((async () => { for await (const chunk of adapter.stream({ ...options, tools: [{ name: 'echo', description: 'Fixture', parameters: { type: 'object' } }] })) chunks.push(chunk); })()).rejects.toThrow();
    expect(posts).toBe(1); expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'finish' }));
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('uses bounded jitter and parses provider seconds and dates', () => {
  expect(recoveryDelay(DEFAULT_RECOVERY, 1, 0)).toBe(800);
  expect(recoveryDelay(DEFAULT_RECOVERY, 2, 1)).toBe(2400);
  expect(recoveryDelay(DEFAULT_RECOVERY, 20, 1)).toBe(30000);
  expect(retryAfter('2', 0)).toBe(2000);
  expect(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1000)).toBe(2000);
  for (const value of ['-1', '0', 'invalid', 'Infinity', 'Thu, 01 Jan 1970 00:00:00 GMT']) expect(retryAfter(value, 1000)).toBeUndefined();
});

it('respects Retry-After and does not retry earlier than an excessive provider delay', async () => {
  const f = await connected(); let posts = 0, retryHeader = '2';
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++;
    return posts === 2 ? sse(scripted([message()])) : Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': retryHeader } });
  }, Date.now, undefined, fast);
  vi.useFakeTimers();
  try {
    const result = collect(adapter.stream(options));
    await vi.waitFor(() => expect(posts).toBe(1));
    await vi.advanceTimersByTimeAsync(1500); expect(posts).toBe(1);
    await vi.advanceTimersByTimeAsync(500); expect((await result).at(-1)).toMatchObject({ type: 'finish' });
    retryHeader = '31';
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'rate_limit_exceeded' });
    expect(posts).toBe(3);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('requires confirmation before interrupting concurrent requests and preserves credentials', async () => {
  const f = await connected(); const original = await f.store.read();
  let posts = 0, hold = true;
  const signals: AbortSignal[] = [];
  const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
    if (String(url).endsWith('/models')) return catalog();
    posts++; signals.push(init!.signal!);
    return hold ? new Promise<Response>(() => {}) : sse(scripted([message()]));
  }, Date.now, undefined, fast);
  try {
    const first = collect(adapter.stream(options)).catch(error => error);
    const second = collect(adapter.stream(options)).catch(error => error);
    await vi.waitFor(() => expect(posts).toBe(2));
    expect(adapter.reconnect(false)).toEqual({ status: 'confirmation_required', activeRequests: 2 });
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    expect(adapter.reconnect(true)).toEqual({ status: 'reconnected', activeRequests: 2 });
    expect(await first).toMatchObject({ code: 'CONNECTION_RESET' }); expect(await second).toMatchObject({ code: 'CONNECTION_RESET' });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(await f.store.read()).toEqual(original);
    hold = false;
    expect((await collect(adapter.stream(options))).at(-1)).toMatchObject({ type: 'finish' });
    expect(posts).toBe(3);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it.each(['reconnect', 'cancel', 'dispose', 'logout'] as const)('stops a recovery wait immediately on %s without another POST', async action => {
  const f = await connected(); let posts = 0;
  const cancellation = new AbortController();
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++; return Response.json({ error: { code: 'server_error' } }, { status: 503 });
  });
  vi.useFakeTimers();
  try {
    const result = collect(adapter.stream({ ...options, signal: cancellation.signal })).catch(error => error);
    await vi.waitFor(() => { expect(posts).toBe(1); expect(vi.getTimerCount()).toBe(1); });
    expect(adapter.reconnect(false)).toEqual({ status: 'confirmation_required', activeRequests: 1 });
    if (action === 'reconnect') adapter.reconnect(true);
    else if (action === 'cancel') cancellation.abort(new DOMException('Cancelled', 'AbortError'));
    else if (action === 'dispose') adapter.dispose();
    else await f.session.logout();
    expect(await result).toMatchObject(action === 'reconnect' || action === 'dispose' ? { code: 'CONNECTION_RESET' } : { name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(60000); expect(posts).toBe(1); expect(vi.getTimerCount()).toBe(0);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('rejects late pre-reset catalog results without deleting a new in-flight read', async () => {
  const f = await connected(); const releases: ((response: Response) => void)[] = [];
  const adapter = new ChatGPTAdapter(f.session, async () => new Promise<Response>(resolve => releases.push(resolve)));
  try {
    const old = adapter.listModels().catch(error => error);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    adapter.reconnect(true); expect(await old).toMatchObject({ code: 'CONNECTION_RESET' });
    const next = adapter.listModels();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!(Response.json({ models: [{ slug: 'stale', display_name: 'Stale', visibility: 'list' }] }));
    const concurrent = adapter.listModels();
    releases[1]!(catalog());
    expect((await next).map(m => m.id)).toEqual(['fixture-model']);
    expect((await concurrent).map(m => m.id)).toEqual(['fixture-model']);
    expect((await adapter.listModels()).map(m => m.id)).toEqual(['fixture-model']);
    expect(releases).toHaveLength(2);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('invalidates a prepared call across reconnect before any POST', async () => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++; return sse(scripted([message()]));
  });
  try {
    const prepared = await adapter.prepareCall(PROVIDER, options.model);
    adapter.reconnect(false);
    await expect(collect(prepared.stream(options))).rejects.toMatchObject({ code: 'CONNECTION_RESET' });
    expect(posts).toBe(0);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it.each(['headers', 'stream'] as const)('recovers a pre-output %s timeout and emits one successful finish', async phase => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    posts++;
    if (posts > 1) return sse(scripted([message()]));
    return phase === 'headers' ? new Promise<Response>(() => {})
      : new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  }, Date.now, { responseTimeoutMs: 1000, idleTimeoutMs: 1000 }, fast);
  vi.useFakeTimers();
  try {
    const result = collect(adapter.stream(options));
    await vi.waitFor(() => expect(posts).toBe(1));
    await vi.advanceTimersByTimeAsync(2000);
    const chunks = await result;
    expect(posts).toBe(2); expect(chunks.filter(c => c.type === 'finish')).toHaveLength(1);
  } finally { adapter.dispose(); f.session.dispose(); }
});

it('recovers a response-body transport failure before content has arrived', async () => {
  const f = await connected(); let posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async url => {
    if (String(url).endsWith('/models')) return catalog();
    if (++posts > 1) return sse(scripted([message()]));
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }), { headers: { 'content-type': 'text/event-stream' } });
  }, Date.now, undefined, fast);
  try { expect((await collect(adapter.stream(options))).at(-1)).toMatchObject({ type: 'finish' }); expect(posts).toBe(2); }
  finally { adapter.dispose(); f.session.dispose(); }
});

it('rejects pre-reset usage reads and keeps the new cached usage', async () => {
  const f = await connected();
  await f.store.update(c => { c.method = 'codex'; });
  const releases: ((response: Response) => void)[] = [];
  const adapter = new ChatGPTAdapter(f.session, async () => new Promise<Response>(resolve => releases.push(resolve)));
  const usage = (used: number) => Response.json({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } } });
  try {
    const old = adapter.usage().catch(error => error);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    adapter.reconnect(true); expect(await old).toMatchObject({ code: 'CONNECTION_RESET' });
    const next = adapter.usage();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(usage(20)); expect((await next)?.windows[0]?.usedPercent).toBe(20);
    releases[0]!(usage(90));
    expect((await adapter.usage())?.windows[0]?.usedPercent).toBe(20); expect(releases).toHaveLength(2);
  } finally { adapter.dispose(); f.session.dispose(); }
});
