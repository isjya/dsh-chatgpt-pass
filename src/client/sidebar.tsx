import { useSyncExternalStore } from 'react';
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { ClientState } from './state.js';
import { UsageCard } from './usage.js';
import { sidebarStyles } from './styles.js';

export const Refresh = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" /></svg>;

function QuotaCard({ client }: { client: ClientState }) {
  const { view, stateError, usage, usageError, usageLoading, now } = useSyncExternalStore(client.subscribeSidebar, client.getSnapshot);
  const canRead = view?.state === 'connected' && view.sharing && !view.signingIn && view.method === 'codex';
  const status = stateError ? '连接状态暂不可用' : !view ? '正在读取余量…' : view.signingIn ? '等待登录完成…'
    : view.state === 'reauth_required' ? '请重新登录 ChatGPT' : !view.sharing ? '连接 ChatGPT 后查看余量'
    : view.method !== 'codex' ? '当前连接不提供余量数据' : usageLoading ? '正在获取余量…' : '暂时无法获取余量';
  return <section className="cgp-sidebar" aria-label="ChatGPT 订阅余量">
    <style>{sidebarStyles}</style>
    <header><span>ChatGPT 余量</span>{canRead && <button type="button" aria-label="刷新侧边栏余量" title="刷新余量" disabled={usageLoading || !!stateError} onClick={() => void client.refreshUsage()}><Refresh /></button>}</header>
    {canRead && usage?.windows.length ? <>
      <div className="cgp-sidebar-windows">{usage.windows.map(w => <UsageCard key={w.id} window={w} now={now} compact />)}</div>
      <p className="cgp-sidebar-note" data-stale={!!(usageError || stateError)} title={usageError || stateError || 'Codex 用量 · 仅供参考'}>
        {usageError || stateError ? '更新失败 · ' : ''}{new Date(usage.observedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} 更新
        {usage.limitReached && <span>已达上限</span>}
      </p>
    </> : <p className="cgp-sidebar-empty" role="status">{status}</p>}
  </section>;
}

/** The rectangular card belongs to the expanded sidebar, leaving the narrow rail clear. */
export function SidebarQuota({ client, wide }: SidebarFooterActionOwnerProps & { client: ClientState }) {
  const preference = useSyncExternalStore(client.sidebar.subscribe, client.sidebar.getSnapshot);
  return preference.value?.showSidebarQuota && wide ? <QuotaCard client={client} /> : null;
}
