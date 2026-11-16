import z from '@deepseek-ai/schemastery';

/** Bounded recovery before an attempt has emitted any content block. */
export interface RecoveryConfig { maxRetries: number; initialDelayMs: number; maxDelayMs: number; jitterRatio: number }
export const DEFAULT_RECOVERY: Readonly<RecoveryConfig> = Object.freeze({ maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.2 });
const fields: z<RecoveryConfig> = z.object({
  maxRetries: z.number().step(1).min(0).max(3).default(DEFAULT_RECOVERY.maxRetries),
  initialDelayMs: z.number().step(1).min(1).max(600000).default(DEFAULT_RECOVERY.initialDelayMs),
  maxDelayMs: z.number().step(1).min(1).max(600000).default(DEFAULT_RECOVERY.maxDelayMs),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_RECOVERY.jitterRatio),
}).default({});
export const RecoverySchema = z.transform(fields, value => {
  if (value.initialDelayMs > value.maxDelayMs) throw new TypeError('recovery.initialDelayMs must not exceed recovery.maxDelayMs');
  return value;
}).default({ ...DEFAULT_RECOVERY });
// The browser receives data-only schemas. Keep the cross-field callback on the
// server; serializing it would leave an uncallable string in the settings form.
const wireRecoverySchema = fields.default({ ...DEFAULT_RECOVERY });
RecoverySchema.toJSON = () => wireRecoverySchema.toJSON();

/** Safe result of checking or resetting this plugin's in-flight requests. */
export interface ReconnectResult { status: 'confirmation_required' | 'reconnected'; activeRequests: number }

/** Parse Retry-After seconds or an HTTP date without retaining the header value. */
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const header = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header) ? Date.parse(header) - now : NaN;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/** Exponential local delay with bounded symmetric jitter. */
export function recoveryDelay(config: RecoveryConfig, retry: number, sample = Math.random()): number {
  return Math.round(Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** (retry - 1) * (1 - config.jitterRatio + 2 * config.jitterRatio * sample)));
}

/** A recovery wait owned by the same cancellation signal as the logical request. */
export function waitForRecovery(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Stop waiting immediately even if a transport has not settled after cancellation. */
export async function abortable<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let remove = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    remove = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  });
  try { const result = await Promise.race([pending, aborted]); signal.throwIfAborted(); return result; } finally { remove(); }
}
