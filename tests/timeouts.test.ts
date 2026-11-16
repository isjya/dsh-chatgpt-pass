import { it, expect, vi } from 'vitest';
import { ChatGPTAdapter } from '../src/llm/adapter.js';
import { PROVIDER } from '../src/llm/request.js';
import { collect, connected, message, scripted, sse } from './helpers.js';
import { DEFAULT_RECOVERY } from '../src/llm/recovery.js';

const options = { provider: PROVIDER, model: 'fixture-model', messages: [] };
const catalog = () => Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });

it('allows response headers after 30 seconds with the default deadline', async () => {
  const f = await connected();
  let received: AbortSignal | undefined, release!: (response: Response) => void;
  const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
    if (String(url).endsWith('/models')) return catalog();
    received = init!.signal!;
    return new Promise(resolve => { release = resolve; });
  });
  vi.useFakeTimers();
  try {
    const result = collect(adapter.stream(options));
    await vi.waitFor(() => expect(received).toBeDefined());
    await vi.advanceTimersByTimeAsync(30001);
    expect(received!.aborted).toBe(false);
    release(sse(scripted([message('delayed response')])));
    expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); f.session.dispose(); }
});

it.each(['headers', 'stream'] as const)('aborts once at the configured %s deadline and persists the phase', async phase => {
  const f = await connected();
  let received: AbortSignal | undefined, posts = 0;
  const adapter = new ChatGPTAdapter(f.session, async (url, init) => {
    if (String(url).endsWith('/models')) return catalog();
    posts++; received = init!.signal!;
    if (phase === 'headers') return new Promise((_, reject) => received!.addEventListener('abort', () => reject(received!.reason), { once: true }));
    return new Response(new ReadableStream({ start(controller) {
      received!.addEventListener('abort', () => controller.error(received!.reason), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }, Date.now, { responseTimeoutMs: 45000, idleTimeoutMs: 90000 }, { ...DEFAULT_RECOVERY, maxRetries: 0 });
  vi.useFakeTimers();
  try {
    const chunks: any[] = [];
    const result = (async () => {
      try { for await (const chunk of adapter.stream(options)) chunks.push(chunk); }
      catch (error) { return error; }
    })();
    await vi.waitFor(() => expect(received).toBeDefined());
    await vi.advanceTimersByTimeAsync(phase === 'headers' ? 44000 : 89000);
    expect(received!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: 'TIMEOUT', diagnostic: { reason: `timeout.${phase}` }, message: expect.stringContaining(`timeout.${phase}`) });
    expect(received!.aborted).toBe(true);
    expect(posts).toBe(1);
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); f.session.dispose(); }
});
