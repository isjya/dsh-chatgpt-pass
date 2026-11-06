import OpenAI from 'openai';
import { LlmAdapter, ReasoningEffortId, attributionHeaders, type GenerateOptions, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ProviderError, safeError, wireError, object } from '../errors.js';
import { type Binding, type Profile, SessionManager } from '../auth/session.js';
import { RESOURCE, json, type Fetch } from '../auth/oauth.js';
import { CODEX_BASE, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from '../auth/codex.js';
import { buildRequest, PROVIDER, toolMap } from './request.js';
import { translate } from './stream.js';
import { mapUsage, type UsageView } from './usage.js';

export class ChatGPTAdapter extends LlmAdapter {
  private cache?: { key: string; expires: number; models: LlmResolvedModelInfo[] };
  private usageCache?: { key: string; expires: number; value: UsageView };
  private pending = new Map<string, Promise<LlmResolvedModelInfo[]>>();
  constructor(readonly session: SessionManager, readonly transport: Fetch = fetch, readonly now = Date.now) { super(); }
  invalidate(): void { this.cache = undefined; this.usageCache = undefined; }
  override providerInfo() { return { id: PROVIDER, name: 'ChatGPT 订阅' }; }
  override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }; }
  // The Codex backend rejects large uncompressed bodies; compress only when the
  // serialized request exceeds the documented practical threshold. SIWC requests
  // stay untouched because that path has no such requirement.
  private outbound(codex: boolean): typeof fetch {
    return async (input, init) => {
      if (codex && typeof init?.body === 'string' && init.body.length > 512 * 1024) {
        const { zstdCompressSync } = await import('node:zlib');
        const headers = new Headers(init.headers); headers.set('content-encoding', 'zstd'); headers.delete('content-length');
        return this.transport(input as any, { ...init, body: zstdCompressSync(init.body) as any, headers, redirect: 'error' });
      }
      return this.transport(input as any, { ...init, redirect: 'error' });
    };
  }
  override async listModels(): Promise<readonly LlmResolvedModelInfo[]> {
    const view = await this.session.view(); if (view.state !== 'connected') return [];
    const { token, binding } = await this.session.access();
    const profile = await this.session.profile();
    const key = `${profile.method}:${profile.accountId ?? ''}:${binding.identity}:${binding.generation}`;
    if (this.cache?.key === key && this.cache.expires > this.now()) return structuredClone(this.cache.models);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.loadModels(token, binding, profile).finally(() => this.pending.delete(key)); this.pending.set(key, pending);
    }
    return structuredClone(await pending);
  }
  private async loadModels(token: string, binding: Binding, profile: Profile): Promise<LlmResolvedModelInfo[]> {
    try {
      const codex = profile.method === 'codex';
      const url = codex ? `${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}` : `${RESOURCE}/models`;
      const r = await this.transport(url, { headers: { Authorization: `Bearer ${token}`, ...(codex ? { originator: CODEX_ORIGINATOR, ...(profile.accountId ? { 'chatgpt-account-id': profile.accountId } : {}) } : {}), ...attributionHeaders() }, signal: AbortSignal.any([this.session.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
      const body = await json(r); if (!r.ok) throw wireError(body, r.status, r.headers.get('x-request-id') ?? undefined);
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
      await this.session.access(binding); this.cache = { key: `${profile.method}:${profile.accountId ?? ''}:${binding.identity}:${binding.generation}`, models, expires: this.now() + 300000 }; return models;
    } catch (e) { const error = safeError(e); this.session.report(error); throw error; }
  }
  /** Codex-only usage windows; the SIWC route has no equivalent contract here. */
  async usage(): Promise<UsageView | undefined> {
    const view = await this.session.view(); if (view.state !== 'connected') return undefined;
    const profile = await this.session.profile(); if (profile.method !== 'codex') return undefined;
    const { token, binding } = await this.session.access();
    const key = `${profile.accountId ?? ''}:${binding.identity}:${binding.generation}`;
    if (this.usageCache?.key === key && this.usageCache.expires > this.now()) return structuredClone(this.usageCache.value);
    try {
      const r = await this.transport(`${CODEX_BASE}/usage`, { headers: { Authorization: `Bearer ${token}`, originator: CODEX_ORIGINATOR, ...(profile.accountId ? { 'chatgpt-account-id': profile.accountId } : {}), ...attributionHeaders() }, signal: AbortSignal.any([this.session.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
      const body = await json(r); if (!r.ok) throw wireError(body, r.status, r.headers.get('x-request-id') ?? undefined);
      const value = mapUsage(body, this.now());
      await this.session.access(binding);
      this.usageCache = { key, expires: this.now() + 30000, value };
      return structuredClone(value);
    } catch (e) { const error = safeError(e); this.session.report(error); throw error; }
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
    const binding = await this.session.binding(), info = await this.resolveModel(provider, model, signal);
    await this.session.access(binding);
    return { model: info, stream: options => this.boundStream(options, binding) };
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal); yield* prepared.stream(options);
  }
  private async *boundStream(options: GenerateOptions, binding: Binding): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.session.signal, ...(options.signal ? [options.signal] : [])]);
    let timer: ReturnType<typeof setTimeout>;
    let timedOut = false;
    const tick = (ms = 120000) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms); timer.unref(); };
    tick(30000);
    try {
      const { token } = await this.session.access(binding); signal.throwIfAborted();
      const profile = await this.session.profile();
      const codex = profile.method === 'codex';
      const body = buildRequest(options, binding.identity, codex);
      // Codex returns encrypted reasoning only when asked; replay needs it for the next turn.
      if (codex) body.include = ['reasoning.encrypted_content'];
      const client = new OpenAI({ apiKey: token, baseURL: codex ? CODEX_BASE : RESOURCE, maxRetries: 0, timeout: 600000,
        ...(codex ? { defaultHeaders: { originator: CODEX_ORIGINATOR, ...(profile.accountId ? { 'chatgpt-account-id': profile.accountId } : {}) } } : {}),
        fetch: this.outbound(codex) });
      const stream = await client.responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, { signal, headers: attributionHeaders() });
      tick();
      try { yield* translate(stream, options.model, binding.identity, toolMap(options.tools), signal, tick); }
      finally { stream.controller.abort(); }
    } catch (e) {
      if (timedOut) throw new ProviderError('TIMEOUT');
      if (signal.aborted) { signal.throwIfAborted(); }
      const error = e instanceof OpenAI.APIConnectionTimeoutError ? new ProviderError('TIMEOUT')
        : e instanceof OpenAI.APIError ? wireError(e.error, e.status, e.requestID ?? undefined) : safeError(e);
      this.session.report(error); throw error;
    } finally { clearTimeout(timer!); controller.abort(); }
  }
}
