import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { connectionKey, type ClientState } from './state.js';
import { resetCountdown } from './usage.js';
import { sidebarStyles } from './styles.js';

export const Refresh = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" /></svg>;

/** Place the native top-layer popover beside the entry, flipping above it on narrow windows. */
function positionPopover(trigger: HTMLElement, panel: HTMLElement): void {
  const anchor = trigger.getBoundingClientRect(), rect = panel.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = window.innerHeight, gap = 8, margin = 12;
  const beside = anchor.right + gap + rect.width <= width - margin;
  const left = beside ? anchor.right + gap : Math.min(anchor.left, width - rect.width - margin);
  const top = beside ? anchor.bottom - rect.height : anchor.top - gap - rect.height;
  panel.style.left = `${Math.max(margin, left)}px`;
  panel.style.top = `${Math.max(margin, Math.min(top, height - rect.height - margin))}px`;
}

function QuotaCard({ client }: { client: ClientState }) {
  const { view, stateError, usage, usageError, usageLoading, now } = useSyncExternalStore(client.subscribeSidebar, client.getSnapshot);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const panelId = useId(), headingId = useId(), [open, setOpen] = useState(false);
  const connection = connectionKey(view), previousConnection = useRef(connection);
  const canRead = view?.state === 'connected' && view.sharing && !view.signingIn && view.method === 'codex';
  const status = stateError ? '连接状态暂不可用' : !view ? '正在读取余量…' : view.signingIn ? '等待登录完成…'
    : view.state === 'reauth_required' ? '请重新登录 ChatGPT' : !view.sharing ? '连接 ChatGPT 后查看余量'
    : view.method !== 'codex' ? '当前连接不提供余量数据' : usageLoading ? '正在获取余量…' : '暂时无法获取余量';
  const primary = canRead ? usage?.windows.find(w => w.id === '5h') : undefined;
  const remaining = primary ? Math.round((100 - primary.usedPercent) * 10) / 10 : undefined;
  const primaryStatus = canRead && usage?.windows.length && !primary ? '5 小时余量暂未提供' : status;
  const updatedAt = usage ? new Date(usage.observedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const position = () => { if (element.matches(':popover-open') && trigger.current) positionPopover(trigger.current, element); };
    const toggle = () => {
      const opened = element.matches(':popover-open'); setOpen(opened);
      if (!opened) return;
      position();
      void client.refreshView().then(() => {
        const current = client.getSnapshot();
        if (!current.usage || current.usageError || Date.now() - current.usage.observedAt >= 60000) void client.refreshUsage();
      });
    };
    element.addEventListener('toggle', toggle);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      element.removeEventListener('toggle', toggle);
      window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
      if (element.isConnected && element.matches(':popover-open')) element.hidePopover();
    };
  }, [client]);
  useLayoutEffect(() => {
    if (panel.current?.matches(':popover-open') && trigger.current) positionPopover(trigger.current, panel.current);
  }, [usage, usageError, stateError, now]);
  useEffect(() => {
    if (previousConnection.current && previousConnection.current !== connection && panel.current?.matches(':popover-open')) panel.current.hidePopover();
    previousConnection.current = connection;
  }, [connection]);
  return <section className="cgp-sidebar" aria-label="ChatGPT 订阅余量">
    <style>{sidebarStyles}</style>
    <button ref={trigger} className="cgp-quota-trigger" type="button" {...{ popovertarget: panelId }} aria-haspopup="dialog" aria-controls={panelId} aria-expanded={open}
      aria-label={`ChatGPT 5 小时余量，${remaining === undefined ? primaryStatus : `剩余 ${remaining}%`}，查看用量详情`} title={usageError || stateError || '查看订阅用量'} data-stale={!!(usageError || stateError)}>
      <span className="cgp-quota-line"><span>ChatGPT <span className="cgp-quota-period">· 5 小时</span></span><strong>{remaining === undefined ? '—' : `${remaining}%`}</strong></span>
      {remaining === undefined ? <span className="cgp-quota-status">{primaryStatus}</span> : <span className="cgp-quota-track" data-tone={remaining === 0 ? 'empty' : remaining <= 20 ? 'warning' : 'normal'} aria-hidden="true"><span style={{ width: `${remaining}%` }} /></span>}
    </button>
    <div ref={panel} id={panelId} className="cgp-quota-popover" {...{ popover: 'auto' }} role="dialog" aria-labelledby={headingId}>
      <h3 id={headingId}>ChatGPT 订阅</h3>
      {canRead && usage?.windows.length ? <>
        <dl>{usage.windows.map(w => <div className="cgp-quota-detail" key={w.id}>
          <dt>{w.id === '5h' ? '5 小时限额' : '每周限额'}</dt><dd>剩余 {Math.round((100 - w.usedPercent) * 10) / 10}%</dd>
          {w.resetAt && <time dateTime={new Date(w.resetAt).toISOString()} title={new Date(w.resetAt).toLocaleString()}>{resetCountdown(w.resetAt, now)}</time>}
        </div>)}</dl>
        {usage.limitReached && <p className="cgp-quota-warning">当前额度已达上限</p>}
      </> : <p className="cgp-quota-empty" role="status">{status}</p>}
      <div className="cgp-quota-updated"><span data-stale={!!(usageError || stateError)}>{usageError || stateError ? usage ? `更新失败 · ${updatedAt} 数据` : '更新失败，请重试' : usage ? `更新于 ${updatedAt}` : '用量以 ChatGPT 为准'}</span>
        {canRead && <button type="button" aria-label="刷新侧边栏余量" disabled={usageLoading} onClick={() => void client.refreshView().then(() => client.refreshUsage())}>{usageLoading ? '更新中…' : '刷新'}</button>}
      </div>
      <a className="cgp-quota-manage" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer noopener">管理用量 <span aria-hidden="true">↗</span></a>
    </div>
  </section>;
}

/** A compact entry in the expanded sidebar; details live in the native top-layer popover. */
export function SidebarQuota({ client, wide }: SidebarFooterActionOwnerProps & { client: ClientState }) {
  const preference = useSyncExternalStore(client.sidebar.subscribe, client.sidebar.getSnapshot);
  return preference.value?.showSidebarQuota && wide ? <QuotaCard client={client} /> : null;
}
