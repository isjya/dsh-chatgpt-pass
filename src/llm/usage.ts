import { ProviderError } from '../errors.js';

export interface UsageWindow {
  id: '5h' | 'weekly';
  label: string;
  usedPercent: number;
  windowSeconds?: number;
  resetAt?: number;
  resetAfterSeconds?: number;
}
export interface UsageView {
  plan?: string;
  limitReached: boolean;
  windows: UsageWindow[];
  observedAt: number;
}
function percent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value * 10) / 10;
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function window(id: '5h' | 'weekly', label: string, value: any, now: number): UsageWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const used = percent(value.used_percent);
  if (used === undefined) return undefined;
  const seconds = positive(value.limit_window_seconds);
  const resetAt = positive(value.reset_at);
  const resetAfter = positive(value.reset_after_seconds);
  return {
    id, label, usedPercent: used,
    ...(seconds ? { windowSeconds: seconds } : {}),
    ...(resetAt && resetAt * 1000 > now / 2 ? { resetAt: Math.round(resetAt * 1000) } : resetAfter ? { resetAt: Math.round(now + resetAfter * 1000) } : {}),
    ...(resetAfter ? { resetAfterSeconds: Math.round(resetAfter) } : {}),
  };
}
/**
 * Reduce the Codex usage payload to the two visible rate-limit windows.
 * Account ids, email and per-model spend details never leave this function.
 */
export function mapUsage(body: any, now = Date.now()): UsageView {
  const rate = body?.rate_limit;
  if (!rate || typeof rate !== 'object') throw new ProviderError('PROTOCOL');
  const windows = [window('5h', '5 小时窗口', rate.primary_window, now), window('weekly', '每周窗口', rate.secondary_window, now)]
    .filter((w): w is UsageWindow => w !== undefined);
  if (!windows.length) throw new ProviderError('PROTOCOL');
  const plan = typeof body.plan_type === 'string' && /^[a-z_]{1,32}$/.test(body.plan_type) ? body.plan_type : undefined;
  return { ...(plan ? { plan } : {}), limitReached: rate.limit_reached === true, windows, observedAt: now };
}
