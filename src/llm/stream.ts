import { ToolCallId, type ContentBlock, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { ProviderError, wireError, type FailureReason } from '../errors.js';
import { digest, envelope, NAMESPACE, type ReplayBlock, type WireItem } from './request.js';

interface Block { index: number; key: string; block: ContentBlock; ended: boolean; items: WireItem[] }
function protocol(reason: FailureReason): ProviderError { return new ProviderError('PROTOCOL', undefined, undefined, undefined, reason); }
export function usage(value: any): TokenUsage | undefined {
  if (!value) return undefined;
  const input = value.input_tokens, output = value.output_tokens, cached = value.input_tokens_details?.cached_tokens ?? 0, reasoning = value.output_tokens_details?.reasoning_tokens;
  if (![input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input || (reasoning !== undefined && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output))) throw protocol('stream.usage');
  return { inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }), ...(value.total_tokens === input + output ? { totalTokens: value.total_tokens } : {}) };
}
export async function* translate(events: AsyncIterable<any>, model: string, identity: string, names: Map<string, string>, signal: AbortSignal, tick: () => void = () => {}): AsyncGenerator<StreamChunk> {
  const blocks: Block[] = [], byKey = new Map<string, Block>(), items = new Map<number, WireItem>(), completed = new Set<number>();
  let pending: WireItem[] = [], size = 0;
  const ensure = (key: string, block: ContentBlock): { block: Block; chunks: StreamChunk[] } => {
    const previous = byKey.get(key); if (previous) return { block: previous, chunks: [] };
    if (blocks.length >= 4096) throw protocol('stream.limit');
    const b: Block = { index: blocks.length, key, block, ended: false, items: pending }; pending = [];
    blocks.push(b); byKey.set(key, b); return { block: b, chunks: [{ type: 'block-start', index: b.index, blockType: block.type }] };
  };
  function* delta(key: string, kind: 'text' | 'reasoning', value: string): Generator<StreamChunk> {
    if (typeof value !== 'string') throw protocol('stream.text');
    const found = ensure(key, { type: kind, text: '' }); yield* found.chunks;
    const b = found.block;
    if (b.ended || b.block.type !== kind) throw protocol('stream.text');
    (b.block as { text: string }).text += value;
    if (value) yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: b.index, text: value };
  }
  function* complete(index: number, item: WireItem): Generator<StreamChunk> {
    if (!item || typeof item.type !== 'string') throw protocol('stream.item');
    const previous = items.get(index);
    if (previous?.id && item.id !== previous.id) throw protocol('stream.item');
    if (completed.has(index)) {
      if (digest({ ...previous, status: undefined }) !== digest({ ...item, status: undefined })) throw protocol('stream.item');
      return;
    }
    items.set(index, item);
    completed.add(index);
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content) || (item.phase !== undefined && !['commentary', 'final_answer'].includes(item.phase))) throw protocol('stream.text');
      for (let part = 0; part < item.content.length; part++) {
        const c = item.content[part], value = c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : undefined;
        if (typeof value !== 'string') throw protocol('stream.text');
        const key = `${index}:${part}`, found = ensure(key, { type: 'text', text: '' }); yield* found.chunks;
        const b = found.block;
        if (b.block.type !== 'text' || !value.startsWith(b.block.text)) throw protocol('stream.text');
        if (!b.ended) {
          yield* delta(key, 'text', value.slice(b.block.text.length));
          b.items.push({ type: 'message', role: 'assistant', ...(item.phase ? { phase: item.phase } : {}), content: [c.type === 'refusal' ? { type: 'refusal', refusal: value } : { type: 'output_text', text: value, annotations: [] }] });
          b.ended = true; yield { type: 'block-end', index: b.index, block: b.block };
        } else if (value !== b.block.text) throw protocol('stream.text');
      }
    } else if (item.type === 'function_call') {
      const name = names.get(item.name);
      if (!name || (item.namespace !== undefined && item.namespace !== NAMESPACE) || typeof item.call_id !== 'string' || !item.call_id || typeof item.arguments !== 'string') throw protocol('stream.tool');
      let args; try { args = JSON.parse(item.arguments); } catch { throw protocol('stream.tool'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw protocol('stream.tool');
      const found = ensure(`${index}:tool`, { type: 'tool-call', id: ToolCallId(item.call_id), name, arguments: '' }); yield* found.chunks;
      const b = found.block;
      if (b.block.type !== 'tool-call' || b.block.id !== item.call_id || b.block.name !== name || !item.arguments.startsWith(b.block.arguments)) throw protocol('stream.tool');
      if (!b.ended) {
        const tail = item.arguments.slice(b.block.arguments.length); b.block.arguments = item.arguments;
        if (tail) yield { type: 'tool-call-delta', index: b.index, id: b.block.id, name, argumentsDelta: tail };
        b.items.push({ type: 'function_call', call_id: item.call_id, namespace: item.namespace ?? NAMESPACE, name: item.name, arguments: item.arguments });
        b.ended = true; yield { type: 'block-end', index: b.index, block: b.block };
      } else if (b.block.arguments !== item.arguments) throw protocol('stream.tool');
    } else if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary)) throw protocol('stream.reasoning');
      const summary = item.summary.map((s: any) => { if (s.type !== 'summary_text' || typeof s.text !== 'string') throw protocol('stream.reasoning'); return s.text; }).join('\n');
      const native: WireItem = { type: 'reasoning', ...(item.id ? { id: item.id } : {}), summary: structuredClone(item.summary), ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {}) };
      const key = `${index}:reasoning`, existing = byKey.get(key);
      if (!summary && !existing) { pending.push(native); return; }
      const found = ensure(key, { type: 'reasoning', text: '' }); yield* found.chunks;
      const b = found.block;
      if (b.block.type !== 'reasoning' || !summary.startsWith(b.block.text)) throw protocol('stream.reasoning');
      if (!b.ended) { yield* delta(key, 'reasoning', summary.slice(b.block.text.length)); b.items.push(native); b.ended = true; yield { type: 'block-end', index: b.index, block: b.block }; }
    } else throw protocol('stream.item');
  }
  for await (const event of events) {
    signal.throwIfAborted(); tick();
    size += JSON.stringify(event).length;
    if (size > 32 * 1024 * 1024 || JSON.stringify(event).length > 4 * 1024 * 1024) throw protocol('stream.limit');
    const i = event.output_index;
    if (event.item_id !== undefined && event.item_id !== items.get(i)?.id) throw protocol('stream.event');
    if (event.type === 'response.output_item.added') {
      if (!Number.isSafeInteger(i) || items.has(i)) throw protocol('stream.event');
      items.set(i, event.item);
      if (event.item.type === 'function_call') {
        const item = event.item, name = names.get(item.name);
        if (!name || typeof item.call_id !== 'string' || !item.call_id || (item.namespace !== undefined && item.namespace !== NAMESPACE)) throw protocol('stream.tool');
        const found = ensure(`${i}:tool`, { type: 'tool-call', id: ToolCallId(item.call_id), name, arguments: '' }); yield* found.chunks;
      } else if (!['message', 'reasoning'].includes(event.item.type)) throw protocol('stream.item');
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (!items.has(i)) throw protocol('stream.event');
      yield* delta(`${i}:${event.content_index}`, 'text', event.delta);
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      if (!items.has(i)) throw protocol('stream.event');
      // Summary parts use a single visible block; separators are confirmed at item completion.
      if (event.summary_index > 0 && !byKey.has(`${i}:reasoning-part:${event.summary_index}`)) {
        byKey.set(`${i}:reasoning-part:${event.summary_index}`, byKey.get(`${i}:reasoning`)!); yield* delta(`${i}:reasoning`, 'reasoning', '\n');
      }
      yield* delta(`${i}:reasoning`, 'reasoning', event.delta);
    } else if (event.type === 'response.function_call_arguments.delta') {
      const b = byKey.get(`${i}:tool`);
      if (!b || b.ended || b.block.type !== 'tool-call' || typeof event.delta !== 'string') throw protocol('stream.tool');
      b.block.arguments += event.delta;
      if (b.block.arguments.length > 1024 * 1024) throw protocol('stream.limit');
      yield { type: 'tool-call-delta', index: b.index, id: b.block.id, name: b.block.name, argumentsDelta: event.delta };
    } else if (event.type === 'response.output_item.done') {
      yield* complete(i, event.item);
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw wireError(event.response?.error ?? event.error ?? event);
    } else if (event.type === 'response.incomplete') throw new ProviderError('STREAM_INTERRUPTED');
    else if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed') throw protocol('stream.completion');
      // SIWC includes the full output here; the Codex backend streams items only and
      // can send an empty output array. In that case the accumulated completed items
      // and ended blocks are the authority, and the block checks below still apply.
      const output = Array.isArray(event.response.output) ? event.response.output : [];
      if (output.length) {
        for (let n = 0; n < output.length; n++) {
          const item = output[n], prior = items.get(n);
          if (completed.has(n)) { if (digest({ ...prior, status: undefined }) !== digest({ ...item, status: undefined })) throw protocol('stream.completion'); }
          else yield* complete(n, item);
        }
        if (items.size !== output.length) throw protocol('stream.completion');
      } else if (!items.size) throw protocol('stream.completion');
      if (!blocks.length || blocks.some(b => !b.ended) || pending.length || new Set(blocks.filter(b => b.block.type === 'tool-call').map(b => (b.block as any).id)).size !== blocks.filter(b => b.block.type === 'tool-call').length) throw protocol('stream.completion');
      const counted = usage(event.response.usage); if (counted) yield { type: 'usage', usage: counted };
      const replay: ReplayBlock[] = blocks.map(b => ({ hash: digest(b.block), items: b.items }));
      yield { type: 'finish', reason: { kind: blocks.some(b => b.block.type === 'tool-call') ? 'tool-calls' : 'stop' }, replayState: envelope(model, identity, replay) }; return;
    }
  }
  signal.throwIfAborted(); throw new ProviderError('STREAM_INTERRUPTED', undefined, undefined, undefined, 'stream.eof');
}
