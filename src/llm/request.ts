import { createHash } from 'node:crypto';
import type { ContentBlock, GenerateOptions, ReplayEnvelope, ToolSchema } from '@deepseek-ai/dsh-llm';
import { ProviderError } from '../errors.js';

export const PROVIDER = 'chatgpt-subscription';
export const NAMESPACE = 'dsh';
export const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const toolName = (name: string): string => `t_${digest(name).slice(0, 48)}`;
export type WireItem = Record<string, any>;
export interface ReplayBlock { hash: string; items: WireItem[] }
export function envelope(model: string, identity: string, blocks: ReplayBlock[]): ReplayEnvelope {
  return { response: { provider: PROVIDER, version: 1, model, identity }, blocks };
}
export function toolMap(tools: readonly ToolSchema[] = []): Map<string, string> {
  const map = new Map<string, string>(); const original = new Set<string>();
  for (const t of tools) {
    const name = toolName(t.name);
    if (!t.name || original.has(t.name) || map.has(name)) throw new ProviderError('PROTOCOL');
    original.add(t.name); map.set(name, t.name);
  }
  return map;
}
function text(blocks: readonly ContentBlock[]): string {
  return blocks.map(b => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool-addition' || b.type === 'tool-removal') return '';
    throw new ProviderError('UNSUPPORTED_INPUT');
  }).join('\n');
}
function explicit(block: ContentBlock): WireItem[] {
  if (block.type === 'text') return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] }];
  if (block.type === 'reasoning') return []; // Visible summaries alone are not authenticated native reasoning.
  if (block.type === 'tool-call') return [{ type: 'function_call', call_id: block.id, namespace: NAMESPACE, name: toolName(block.name), arguments: block.arguments }];
  throw new ProviderError('UNSUPPORTED_INPUT');
}
function checkedReplay(items: WireItem[], block: ContentBlock): WireItem[] {
  let visible = 0;
  const projected = items.map(item => {
    if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary) || item.summary.some((s: any) => s.type !== 'summary_text' || typeof s.text !== 'string') || (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string')) throw new ProviderError('REPLAY_INVALID');
      if (item.summary.length) { if (block.type !== 'reasoning' || item.summary.map((s: any) => s.text).join('\n') !== block.text) throw new ProviderError('REPLAY_INVALID'); visible++; }
      return { type: 'reasoning', ...(typeof item.id === 'string' ? { id: item.id } : {}), summary: structuredClone(item.summary), ...(item.encrypted_content === undefined ? {} : { encrypted_content: item.encrypted_content }) };
    }
    if (++visible > 1) throw new ProviderError('REPLAY_INVALID');
    if (item.type === 'message') {
      if (block.type !== 'text' || item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length !== 1 || (item.phase !== undefined && !['commentary', 'final_answer'].includes(item.phase))) throw new ProviderError('REPLAY_INVALID');
      const part = item.content[0];
      if (part.type === 'output_text' && part.text === block.text) return { type: 'message', role: 'assistant', ...(item.phase ? { phase: item.phase } : {}), content: [{ type: 'output_text', text: block.text, annotations: [] }] };
      if (part.type === 'refusal' && part.refusal === block.text) return { type: 'message', role: 'assistant', ...(item.phase ? { phase: item.phase } : {}), content: [{ type: 'refusal', refusal: block.text }] };
    }
    if (item.type === 'function_call' && block.type === 'tool-call' && item.call_id === block.id && item.name === toolName(block.name) && item.namespace === NAMESPACE && item.arguments === block.arguments) {
      return { type: 'function_call', namespace: NAMESPACE, name: item.name, call_id: block.id, arguments: block.arguments };
    }
    throw new ProviderError('REPLAY_INVALID');
  });
  if (visible !== 1) throw new ProviderError('REPLAY_INVALID');
  return projected;
}
export function buildRequest(options: GenerateOptions, identity: string, allowReasoning = false): WireItem {
  const input: WireItem[] = [], instructions: string[] = [];
  if (options.system) instructions.push(options.system);
  if (options.stop?.length || (options.reasoningEffort !== undefined && !allowReasoning)) throw new ProviderError('subscription_sharing_unsupported_capability');
  const seenCalls = new Set<string>(), answered = new Set<string>();
  for (const m of options.messages) {
    if (m.role === 'system') { instructions.push(text(m.content)); continue; }
    if (m.role === 'assistant') {
      const replay = m.source.replayState as ReplayEnvelope | undefined;
      if (replay && m.source.provider === PROVIDER) {
        const meta = replay.response as any;
        if (!meta || meta.provider !== PROVIDER || meta.version !== 1 || meta.identity !== identity || meta.model !== options.model || !Array.isArray(replay.blocks) || replay.blocks.length !== m.content.length) throw new ProviderError('REPLAY_INVALID');
        for (let i = 0; i < m.content.length; i++) {
          const block = m.content[i]!, rb = replay.blocks[i] as ReplayBlock;
          if (!rb || !Array.isArray(rb.items)) throw new ProviderError('REPLAY_INVALID');
          // Rewrites/cropping never resurrect the native payload of a changed block.
          if (rb.hash !== digest(block)) {
            if (block.type === 'tool-call') throw new ProviderError('REPLAY_INVALID');
            input.push(...explicit(block));
          } else input.push(...checkedReplay(rb.items, block));
        }
      } else {
        for (const block of m.content) input.push(...explicit(block));
      }
      for (const b of m.content) if (b.type === 'tool-call') { if (seenCalls.has(b.id)) throw new ProviderError('REPLAY_INVALID'); seenCalls.add(b.id); }
    } else if (m.role === 'tool') {
      if (!seenCalls.has(m.toolCallId) || answered.has(m.toolCallId)) throw new ProviderError('REPLAY_INVALID');
      answered.add(m.toolCallId);
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.isError ? JSON.stringify({ error: text(m.content) }) : text(m.content) });
    } else if (m.role === 'developer') {
      const content = text(m.content); if (content) input.push({ role: 'developer', content });
    } else input.push({ role: 'user', content: text(m.content) });
  }
  for (const id of seenCalls) if (!answered.has(id)) throw new ProviderError('REPLAY_INVALID');
  toolMap(options.tools);
  return { model: options.model, input, ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}), store: false, stream: true,
    ...(allowReasoning && options.reasoningEffort !== undefined ? { reasoning: { effort: options.reasoningEffort } } : {}),
    ...(options.tools?.length ? { tools: [{ type: 'namespace', name: NAMESPACE, description: 'Tools executed by the local Harness.', tools: options.tools.map(t => ({ type: 'function', name: toolName(t.name), description: t.description, parameters: t.parameters, strict: false })) }] } : {}) };
}
