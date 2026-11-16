import OpenAI from 'openai';
import { LlmAdapter, ReasoningEffortId, attributionHeaders, type GenerateOptions, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ProviderError, safeError, wireError, object } from '../errors.js';
import { type Binding, type Profile, SessionManager } from '../auth/session.js';
import { RESOURCE, json, type Fetch } from '../auth/oauth.js';
import { CODEX_BASE, CODEX_USAGE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from '../auth/codex.js';
import { buildRequest, PROVIDER, toolMap } from './request.js';
import { translate } from './stream.js';
import { mapUsage, type UsageView } from './usage.js';
import { abortable, DEFAULT_RECOVERY, recoveryDelay, retryAfter, waitForRecovery, type RecoveryConfig, type ReconnectResult } from './recovery.js';

/** Response-header and inter-event deadlines for each network attempt. */
export interface StreamTimeouts { responseTimeoutMs: number; idleTimeoutMs: number }
class AttemptFailure {
  constructor(readonly failure: ProviderError, readonly retryable: boolean, readonly retryAfterMs?: number) {}
}
async function* networkEvents(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  try { yield* events; }
  catch (error) {
    if (error instanceof TypeError) throw new ProviderError('NETWORK', undefined, undefined, undefined, 'stream.transport');
    throw error;
  }
}
export class ChatGPTAdapter extends LlmAdapter {
  private cache?: { key: string; expires: number; models: LlmResolvedModelInfo[] };
  private usageCache?: { key: string; expires: number; value: UsageView };
  private pending = new Map<string, Promise<LlmResolvedModelInfo[]>>();
  private network = new AbortController();
  private active = new Set<symbol>();
  constructor(readonly session: SessionManager, readonly transport: Fetch = fetch, readonly now = Date.now,
    readonly timeouts: StreamTimeouts | (() => StreamTimeouts) = { responseTimeoutMs: 120000, idleTimeoutMs: 120000 },
    readonly recovery: RecoveryConfig | (() => RecoveryConfig) = DEFAULT_RECOVERY) { super(); }
  invalidate(): void { this.cache = undefined; this.usageCache = undefined; }
  /** Check for active work before resetting only this plugin's requests and caches. */
  reconnect(confirmed: boolean): ReconnectResult {
    const activeRequests = this.active.size;
    if (activeRequests && !confirmed) return { status: 'confirmation_required', activeRequests };
    const old = this.network;
    this.network = new AbortController();
    this.active.clear(); this.pending.clear(); this.invalidate();
    old.abort(new ProviderError('CONNECTION_RESET'));
    return { status: 'reconnected', activeRequests };
  }
  /** Abort requests and recovery waits when the plugin is unloaded. */
  dispose(): void {
    this.network.abort(new ProviderError('CONNECTION_RESET'));
    this.active.clear(); this.pending.clear(); this.invalidate();
  }
  override providerInfo() { return { id: PROVIDER, name: 'ChatGPT 订阅' }; }
  override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }; }
  // The Codex backend rejects large uncompressed bodies; compress only when the
  // serialized request exceeds the documented practical threshold. SIWC requests
  // stay untouched because that path has no such requirement.
  private async request(input: Parameters<Fetch>[0], init: RequestInit, network: AbortSignal): Promise<Response> {
    const signal = AbortSignal.any([network, this.session.signal, ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const pending = this.transport(input, { ...init, signal, redirect: 'error' });
    void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    return abortable(pending, signal);
  }
  private outbound(codex: boolean, network: AbortSignal): typeof fetch {
    return async (input, init) => {
      if (codex && typeof init?.body === 'string' && init.body.length > 512 * 1024) {
        const { zstdCompressSync } = await import('node:zlib');
        const headers = new Headers(init.headers); headers.set('content-encoding', 'zstd'); headers.delete('content-length');
        return this.request(input as any, { ...init, body: zstdCompressSync(init.body) as any, headers }, network);
      }
      return this.request(input as any, { ...init }, network);
    };
  }
  override async listModels(): Promise<readonly LlmResolvedModelInfo[]> {
    const network = this.network.signal;
    network.throwIfAborted();
    const view = await this.session.view(); if (view.state !== 'connected' || view.signingIn) return [];
    const { token, binding } = await this.session.access();
    const profile = await this.session.profile();
    network.throwIfAborted();
    const key = `${profile.method}:${profile.accountId ?? ''}:${binding.identity}:${binding.generation}`;
    if (this.cache?.key === key && this.cache.expires > this.now()) return structuredClone(this.cache.models);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.loadModels(token, binding, profile, network).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); }); this.pending.set(key, pending);
    }
    return structuredClone(await pending);
  }
  private async loadModels(token: string, binding: Binding, profile: Profile, network: AbortSignal): Promise<LlmResolvedModelInfo[]> {
    const lease = Symbol(); this.active.add(lease);
    // Request failures belong to their caller, not the session's authorization alert.
    try {
      const codex = profile.method === 'codex';
      const url = codex ? `${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}` : `${RESOURCE}/models`;
      const signal = AbortSignal.any([network, this.session.signal, AbortSignal.timeout(15000)]);
      const r = await this.request(url, { headers: { Authorization: `Bearer ${token}`, ...(codex ? { originator: CODEX_ORIGINATOR, ...(profile.accountId ? { 'chatgpt-account-id': profile.accountId } : {}) } : {}), ...attributionHeaders() }, signal }, network);
      const body = await abortable(json(r), signal); if (!r.ok) throw wireError(body, r.status, r.headers.get('x-request-id') ?? undefined);
      const list = object(body).models;
      if (!Array.isArray(list)) throw new ProviderError('PROTOCOL');
      const seen = new Set<string>();
      const label = (effort: string) => effort === 'xhigh' ? 'Extra high' : effort === 'max' ? 'Maximum' : effort.charAt(0).toUpperCase() + effort.slice(1);
      const models = list.filter((m: any) => codex ? (m.visibility ?? 'list') === 'list' : m.visibility === 'list').map((m: any): LlmResolvedModelInfo => {
        const id = m.slug, name = codex ? (m.display_name ?? m.slug) : m.display_name;
        if (typeof id !== 'string' || !id || typeof name !== 'string' || seen.has(id)) throw new ProviderError('PROTOCOL');
        seen.add(id);
        if (!codex) return { provider: PROVIDER, id, name, inputModalities: ['text'] };
        const efforts = Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.filter((l: any) => l && typeof l.effort === 'string' && l.effort).map((l: any) => ({
            id: ReasoningEffortId(l.effort), name: label(l.effort),
            ...(typeof l.description === 'string' && l.description ? { description: l.description } : {}),
          }))
          : [];
        const defaultEffort = typeof m.default_reasoning_level === 'string' && efforts.some((e: any) => String(e.id) === m.default_reasoning_level)
          ? ReasoningEffortId(m.default_reasoning_level) : undefined;
        return { provider: PROVIDER, id, name, inputModalities: ['text'],
          ...(Number.isSafeInteger(m.context_window) && m.context_window > 0 ? { context: { contextWindow: m.context_window } } : {}),
          ...(efforts.length ? { reasoning: { efforts, ...(defaultEffort ? { defaultEffort } : {}) } } : {}) };
      });
      await this.session.access(binding); signal.throwIfAborted(); this.cache = { key: `${profile.method}:${profile.accountId ?? ''}:${binding.identity}:${binding.generation}`, models, expires: this.now() + 300000 }; return models;
    } catch (e) { network.throwIfAborted(); throw safeError(e); }
    finally { this.active.delete(lease); }
  }
  /** Codex-only usage windows; the SIWC route has no equivalent contract here. */
  async usage(): Promise<UsageView | undefined> {
    const network = this.network.signal;
    network.throwIfAborted();
    const view = await this.session.view(); if (view.state !== 'connected' || view.signingIn) return undefined;
    const profile = await this.session.profile(); if (profile.method !== 'codex') return undefined;
    const { token, binding } = await this.session.access();
    network.throwIfAborted();
    const key = `${profile.accountId ?? ''}:${binding.identity}:${binding.generation}`;
    if (this.usageCache?.key === key && this.usageCache.expires > this.now()) return structuredClone(this.usageCache.value);
    const lease = Symbol(); this.active.add(lease);
    try {
      const signal = AbortSignal.any([network, this.session.signal, AbortSignal.timeout(15000)]);
      const r = await this.request(CODEX_USAGE_URL, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', originator: CODEX_ORIGINATOR, ...(profile.accountId ? { 'chatgpt-account-id': profile.accountId } : {}), ...attributionHeaders() }, signal }, network);
      const body = await abortable(json(r), signal); if (!r.ok) throw wireError(body, r.status, r.headers.get('x-request-id') ?? undefined);
      const value = mapUsage(body, this.now());
      await this.session.access(binding);
      signal.throwIfAborted();
      this.usageCache = { key, expires: this.now() + 30000, value };
      return structuredClone(value);
    } catch (e) { network.throwIfAborted(); throw safeError(e); }
    finally { this.active.delete(lease); }
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    if (provider !== PROVIDER) throw new ProviderError('MODEL_UNAVAILABLE');
    const catalog = this.listModels();
    let remove = () => {};
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true }); remove = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    });
    let models: readonly LlmResolvedModelInfo[];
    try { models = await Promise.race([catalog, aborted]); } finally { remove(); }
    const resolved = models.find(m => m.id === model); signal?.throwIfAborted();
    if (!resolved) throw new ProviderError('MODEL_UNAVAILABLE'); return resolved;
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const network = this.network.signal;
    const binding = await this.session.binding(), info = await this.resolveModel(provider, model, signal);
    await this.session.access(binding);
    network.throwIfAborted();
    return { model: info, stream: options => this.boundStream(options, binding, network) };
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal); yield* prepared.stream(options);
  }
  private async *boundStream(options: GenerateOptions, binding: Binding, network: AbortSignal): AsyncGenerator<StreamChunk> {
    const timeouts = { ...(typeof this.timeouts === 'function' ? this.timeouts() : this.timeouts) };
    const recovery = { ...(typeof this.recovery === 'function' ? this.recovery() : this.recovery) };
    const signal = AbortSignal.any([network, this.session.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    const lease = Symbol(); this.active.add(lease);
    try {
      await abortable(this.session.access(binding), signal);
      const profile = await abortable(this.session.profile(), signal);
      const body = buildRequest(options, binding.identity, profile.method === 'codex');
      if (profile.method === 'codex') body.include = ['reasoning.encrypted_content'];
      const names = toolMap(options.tools);
      for (let retry = 0; ; retry++) {
        signal.throwIfAborted();
        try { yield* this.attemptStream(options, binding, profile, body, names, timeouts, signal); return; }
        catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof AttemptFailure)) throw error;
          const wait = error.retryAfterMs ?? recoveryDelay(recovery, retry + 1);
          if (!error.retryable || retry >= recovery.maxRetries || wait > recovery.maxDelayMs) {
            const e = error.failure, d = e.diagnostic;
            throw new ProviderError(e.code, d.status, d.requestId, d.param, d.reason, retry);
          }
          await waitForRecovery(wait, signal);
        }
      }
    } finally { this.active.delete(lease); }
  }
  private async *attemptStream(options: GenerateOptions, binding: Binding, profile: Profile, body: ReturnType<typeof buildRequest>,
    names: Map<string, string>, timeouts: StreamTimeouts, parent: AbortSignal): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, parent]);
    let timer: ReturnType<typeof setTimeout>;
    let timedOut = false;
    let receivedHeaders = false;
    let emitted = false;
    const tick = (ms = timeouts.idleTimeoutMs) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms); timer.unref(); };
    tick(timeouts.responseTimeoutMs);
    try {
      const { token } = await abortable(this.session.access(binding), signal); signal.throwIfAborted();
      const codex = profile.method === 'codex';
      const client = new OpenAI({ apiKey: token, baseURL: codex ? CODEX_BASE : RESOURCE, maxRetries: 0, timeout: 600000,
        ...(codex ? { defaultHeaders: { originator: CODEX_ORIGINATOR, ...(profile.accountId ? { 'chatgpt-account-id': profile.accountId } : {}) } } : {}),
        fetch: this.outbound(codex, parent) });
      const stream = await client.responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, { signal, headers: attributionHeaders() });
      receivedHeaders = true;
      tick();
      try {
        for await (const chunk of translate(networkEvents(stream), options.model, binding.identity, names, signal, tick)) {
          if (chunk.type !== 'usage' && chunk.type !== 'finish') emitted = true;
          yield chunk;
        }
      }
      finally { stream.controller.abort(); }
    } catch (e) {
      parent.throwIfAborted();
      const error = timedOut ? new ProviderError('TIMEOUT', undefined, undefined, undefined, receivedHeaders ? 'timeout.stream' : 'timeout.headers')
        : e instanceof OpenAI.APIConnectionTimeoutError ? new ProviderError('TIMEOUT')
        : e instanceof OpenAI.APIConnectionError ? new ProviderError('NETWORK')
        : e instanceof OpenAI.APIError ? wireError(e.error, e.status, e.requestID ?? undefined)
        : e instanceof SyntaxError ? new ProviderError('PROTOCOL', undefined, undefined, undefined, 'stream.json') : safeError(e);
      const status = error.diagnostic.status;
      const permanentHttp = status !== undefined && ![408, 500, 502, 503, 504].includes(status) && !(status === 429 && error.code === 'rate_limit_exceeded');
      const retryable = !emitted && !permanentHttp && (timedOut || e instanceof OpenAI.APIConnectionError
        || ['HTTP_408', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'server_error', 'rate_limit_exceeded'].includes(error.code)
        || error.diagnostic.reason === 'stream.eof' || error.diagnostic.reason === 'stream.transport');
      throw new AttemptFailure(error, retryable, e instanceof OpenAI.APIError ? retryAfter(e.headers?.get('retry-after') ?? null, this.now()) : undefined);
    } finally { clearTimeout(timer!); controller.abort(); }
  }
}
