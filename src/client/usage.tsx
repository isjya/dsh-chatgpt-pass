import type { UsageWindow } from '../llm/usage.js';

/** Format a reset deadline without suggesting that an expired window has refreshed. */
export function resetCountdown(resetAt: number, now: number): string {
  if (resetAt <= now) return '即将重置';
  const totalMinutes = Math.max(1, Math.ceil((resetAt - now) / 60000));
  const days = Math.floor(totalMinutes / 1440), hours = Math.floor(totalMinutes % 1440 / 60), minutes = totalMinutes % 60;
  if (days) return `${days}天${hours ? `${hours}小时` : ''}后重置`;
  if (hours) return `${hours}小时${minutes ? `${minutes}分钟` : ''}后重置`;
  return `${minutes}分钟后重置`;
}

/** The bar measures remaining quota; an absent window is never represented as zero. */
export function UsageCard({ window: w, now = Date.now(), compact = false }: { window: UsageWindow; now?: number; compact?: boolean }) {
  const remaining = Math.round((100 - w.usedPercent) * 10) / 10;
  const label = w.id === '5h' ? '5 小时限额' : '每周限额';
  return <div className="cgp-usage-window">
    {!compact && <h3 className="cgp-usage-label">{label}</h3>}
    <div className="cgp-usage-meta">
      {compact ? <span title={w.resetAt ? resetCountdown(w.resetAt, now) : '重置时间暂未提供'}>{w.id === '5h' ? '5 小时' : '每周'}</span> : <span className="cgp-reset">{w.resetAt ? <time dateTime={new Date(w.resetAt).toISOString()} title={new Date(w.resetAt).toLocaleString()}>{resetCountdown(w.resetAt, now)}</time> : '重置时间暂未提供'}</span>}
      <span className="cgp-remaining">剩余 {remaining}%</span>
    </div>
    <div className="cgp-meter" data-tone={remaining === 0 ? 'empty' : remaining <= 20 ? 'warning' : 'normal'} role="meter" aria-label={`${label}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={`剩余 ${remaining}%`}>
      <div className="cgp-meter-fill" style={{ width: `${remaining}%` }} />
    </div>
  </div>;
}
