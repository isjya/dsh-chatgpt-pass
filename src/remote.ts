import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol';

/** Explicit consent to interrupt all requests owned by this plugin. */
export interface ReconnectOptions { confirmed: boolean }

/** Validate the reconnect payload without reflecting any supplied values into errors. */
export function parseReconnectOptions(value: unknown): ReconnectOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'confirmed')
    || !('confirmed' in value) || typeof value.confirmed !== 'boolean' || Object.keys(value).some(key => key !== 'confirmed')) {
    throw new TypeError('Reconnect options require exactly one boolean confirmed field');
  }
  return { confirmed: value.confirmed };
}

/** Gateway Clients require a strict input codec before mounting a parameterized Remote. */
export const reconnectOptionsCodec: TypertCodec<ReconnectOptions> = {
  mode: 'strict', typeSymbol: 'dsh-chatgpt-pass.ReconnectOptions',
  create: () => ({ parse: parseReconnectOptions }),
  jsonSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'], additionalProperties: false },
};
