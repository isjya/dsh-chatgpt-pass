import { ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm';

// Exact model ids only. Checked against OpenAI's model pages on 2026-11-16.
// These supplement catalogs that omit effort metadata; explicit server metadata wins.
const standard = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const thinking = ['low', 'medium', 'high', 'xhigh', 'max'];
const documented: Readonly<Record<string, readonly string[]>> = {
  'gpt-6.1-sol': thinking, 'gpt-6-astra': thinking,
  'gpt-6.1-terra': standard, 'gpt-6-sol': standard, 'gpt-6-luna': standard,
  'gpt-5.6': standard, 'gpt-5.6-sol': standard, 'gpt-5.6-terra': standard, 'gpt-5.6-luna': standard,
};
const label = (effort: string) => effort === 'xhigh' ? 'Extra high' : effort === 'max' ? 'Maximum' : effort.charAt(0).toUpperCase() + effort.slice(1);

/** Shared catalog capabilities for SIWC and Codex, without guessing unknown model ids. */
export function modelReasoning(model: Record<string, any>, useDocumentedFallback: boolean): LlmModelReasoningInfo | undefined {
  if (model.supports_reasoning === false) return undefined;
  const levels = Object.hasOwn(model, 'supported_reasoning_levels') ? model.supported_reasoning_levels
    : useDocumentedFallback && Object.hasOwn(documented, model.slug) ? documented[model.slug]!.map(effort => ({ effort })) : [];
  if (!Array.isArray(levels)) return undefined;
  const seen = new Set<string>();
  const efforts = levels.flatMap(level => {
    if (!level || typeof level.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(level.effort) || seen.has(level.effort)) return [];
    seen.add(level.effort);
    return [{ id: ReasoningEffortId(level.effort), name: label(level.effort),
      ...(typeof level.description === 'string' && level.description ? { description: level.description } : {}) }];
  });
  if (!efforts.length) return undefined;
  const defaultEffort = typeof model.default_reasoning_level === 'string' && seen.has(model.default_reasoning_level)
    ? ReasoningEffortId(model.default_reasoning_level) : undefined;
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}
