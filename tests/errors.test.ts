import { it, expect } from 'vitest';
import { ProviderError, wireError } from '../src/errors.js';
import { collect, events, message, scripted, secret } from './helpers.js';
import { translate } from '../src/llm/stream.js';
import { HarnessError } from '@deepseek-ai/dsh-llm';

it('carries custom provider failure facts across the public Harness error boundary', () => {
  const error = new ProviderError('REPLAY_IDENTITY_MISMATCH', 403, 'req_fixture');
  expect(error).toBeInstanceOf(HarnessError);
  expect(error.failure).toEqual({ message: error.message, code: 'REPLAY_IDENTITY_MISMATCH', status: 403, requestId: 'req_fixture' });
  expect(Object.isFrozen(error.failure)).toBe(true);
  const sanitized = new ProviderError(secret, 502, secret);
  expect(sanitized.failure.code).toBe('PROTOCOL');
  expect(sanitized.failure.requestId).toBeUndefined();
  expect(JSON.stringify(sanitized)).not.toContain(secret);
  for (const status of [99, 600, 200.5, NaN]) expect(() => new ProviderError('PROTOCOL', status)).toThrow('status');
});

it.each([400, 401, 403, 408, 413, 422, 429, 500, 502, 503, 504])('keeps HTTP %s distinct from response validation failures', status => {
  const error = wireError({ error: { code: 'unrecognized_code', message: secret } }, status, 'req_fixture');
  expect(error).toMatchObject({ code: `HTTP_${status}`, diagnostic: { status, requestId: 'req_fixture' } });
  expect(error.message).not.toContain('插件版本');
  expect(JSON.stringify(error)).not.toContain(secret);
});

it('distinguishes unknown HTTP and in-stream errors without exposing upstream content', () => {
  expect(wireError({ error: { message: secret } }, 409)).toMatchObject({ code: 'HTTP_ERROR', diagnostic: { status: 409 } });
  expect(wireError({ error: { message: secret } })).toMatchObject({ code: 'UPSTREAM_ERROR' });
  expect(wireError({ error: { code: secret, type: 'server_error', message: secret } }, 500).code).toBe('server_error');
  expect(wireError({ error: { code: 'context_length_exceeded', type: 'invalid_request_error' } }, 400).code).toBe('context_length_exceeded');
});

it.each(['response.failed', 'error'])('reports an unrecognized %s as an upstream failure', async type => {
  await expect(collect(translate(events([{ type, response: { error: { code: 'unrecognized_code', message: secret } }, error: { message: secret } }]),
    'fixture-model', 'identity', new Map(), AbortSignal.timeout(5000)))).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
});

it.each([
  ['stream.event', [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: secret }]],
  ['stream.item', [{ type: 'response.output_item.added', output_index: 0, item: { type: 'unrecognized_item', payload: secret } }]],
  ['stream.tool', [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: secret, call_id: 'call_fixture' } }]],
  ['stream.text', [
    { type: 'response.output_item.added', output_index: 0, item: { ...message(), content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: secret },
    { type: 'response.output_item.done', output_index: 0, item: message('different') },
  ]],
  ['stream.reasoning', [{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'invalid', text: secret }] } }]],
  ['stream.completion', [{ type: 'response.completed', response: { status: 'completed', output: [] } }]],
  ['stream.usage', [...scripted([message()]).slice(0, -1), { type: 'response.completed', response: { status: 'completed', output: [message()], usage: { input_tokens: 1, output_tokens: -1 } } }]],
  ['stream.limit', [{ type: 'response.created', payload: 'x'.repeat(4 * 1024 * 1024) }]],
] as const)('persists the safe %s diagnosis without a successful finish or upstream content', async (reason, script) => {
  const chunks: any[] = [];
  let failure: unknown;
  try { for await (const chunk of translate(events([...script]), 'fixture-model', 'identity', new Map(), AbortSignal.timeout(5000))) chunks.push(chunk); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ProviderError);
  expect(failure).toMatchObject({ code: 'PROTOCOL', diagnostic: { reason }, message: expect.stringContaining(reason) });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false);
});
