import { useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { TypertClientRemote, TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionView } from '../auth/session.js';
import type { UsageView } from '../llm/usage.js';
import { UsageCard } from './usage.js';
import { styles } from './styles.js';

interface Api {
  view(): Promise<RemoteResult<SessionView>>;
  login(): Promise<RemoteResult<{ url: string }>>;
  loginCodex(): Promise<RemoteResult<{ url: string }>>;
  consent(): Promise<RemoteResult<{ url: string }>>;
  cancel(): Promise<RemoteResult<void>>;
  models(): Promise<RemoteResult<{ id: string; name: string }[]>>;
  usage(): Promise<RemoteResult<UsageView | null>>;
  logout(): Promise<RemoteResult<{ remoteRevoked: boolean }>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { chatgptProvider: Api }
}
// No business input parameters; public descriptor mounting preserves host ownership and lifecycle.
export const contribution: TypertRemoteContribution = { package: 'dsh-chatgpt-pass', descriptors: ['view', 'login', 'loginCodex', 'consent', 'cancel', 'models', 'usage', 'logout'].map(method => ({
  id: `dsh-chatgpt-pass:chatgptProvider/${method}`, service: 'chatgptProvider', namespace: 'chatgptProvider', method, invocation: { kind: 'direct' as const }, parameters: [], result: { mode: 'src-json' as const },
})) };
async function value<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request; if (!result.ok) throw new Error(result.error.message); return result.value;
}
function officialLink(raw: string): string {
  const u = new URL(raw); if (u.origin !== 'https://auth.openai.com' || !['/api/accounts/authorize', '/oauth/authorize'].includes(u.pathname)) throw new Error('授权地址未通过验证。'); return u.href;
}
const labels = { disconnected: '未连接', connected: '已连接', identity_only: '待开启订阅共享', reauth_required: '需要重新登录' };
const Chevron = () => <svg className="cgp-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
const Refresh = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" /></svg>;
export function Settings({ api }: { api: Api }) {
  const [view, setView] = useState<SessionView>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [stateError, setStateError] = useState('');
  const [models, setModels] = useState<{ id: string; name: string }[]>([]), [link, setLink] = useState(''), [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false), [usageLoading, setUsageLoading] = useState(false);
  const [modelsError, setModelsError] = useState(''), [usageError, setUsageError] = useState('');
  const popup = useRef<Window | null>(null), waiting = useRef(false);
  // Credentials can be committed before the authorization flow rotates its signal.
  // Wait for that flow to finish before starting account-bound reads.
  const connection = view?.sharing && !view.signingIn ? `${view.method}:${view.account ?? ''}` : '';
  const currentConnection = useRef(connection); currentConnection.current = connection;
  useEffect(() => {
    let disposed = false, reading = false;
    const cancelOwned = () => { if (waiting.current) { waiting.current = false; void value(api.cancel()).catch(() => {}); } };
    const refresh = () => {
      if (waiting.current && popup.current?.closed) cancelOwned();
      if (reading) return;
      reading = true;
      void value(api.view()).then(v => { if (!disposed) { setView(v); setStateError(''); if (!v.signingIn) { waiting.current = false; popup.current = null; setLink(''); } } }, () => { if (!disposed) setStateError('暂时无法读取连接状态。'); }).finally(() => { reading = false; });
    };
    window.addEventListener('pagehide', cancelOwned);
    refresh(); const timer = setInterval(refresh, 2000); return () => { disposed = true; clearInterval(timer); window.removeEventListener('pagehide', cancelOwned); cancelOwned(); };
  }, [api]);
  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setModels([]); setUsage(null); setModelsError(''); setUsageError('');
    setModelsLoading(Boolean(connection)); setUsageLoading(Boolean(connection && view?.method === 'codex'));
    if (connection) {
      void value(api.models()).then(m => { if (!disposed) setModels(m); }, () => { if (!disposed) setModelsError('模型暂时无法加载，请重试。'); }).finally(() => { if (!disposed) setModelsLoading(false); });
      if (view?.method === 'codex') {
        const loadUsage = async (retry: boolean) => {
          let retrying = false;
          try { const next = await value(api.usage()); if (!disposed) { setUsage(next); setUsageError(''); } }
          catch {
            if (!disposed && retry) { retrying = true; retryTimer = setTimeout(() => void loadUsage(false), 1000); }
            else if (!disposed) setUsageError('用量暂时无法更新，请重试。');
          } finally { if (!disposed && !retrying) setUsageLoading(false); }
        };
        void loadUsage(true);
      }
    }
    return () => { disposed = true; clearTimeout(retryTimer); };
  }, [api, connection]);
  const refreshModels = async () => {
    const key = connection; setModelsLoading(true); setModelsError('');
    try { const next = await value(api.models()); if (currentConnection.current === key) setModels(next); }
    catch { if (currentConnection.current === key) setModelsError('模型暂时无法加载，请重试。'); }
    finally { if (currentConnection.current === key) setModelsLoading(false); }
  };
  const refreshUsage = async () => {
    const key = connection; setUsageLoading(true); setUsageError('');
    try { const next = await value(api.usage()); if (currentConnection.current === key) setUsage(next); }
    catch { if (currentConnection.current === key) setUsageError('用量暂时无法更新，请重试。'); }
    finally { if (currentConnection.current === key) setUsageLoading(false); }
  };
  const run = async (f: () => Promise<void>) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      await f();
      try { setView(await value(api.view())); setStateError(''); } catch { setStateError('暂时无法读取连接状态。'); }
    } catch (e) { setError(e instanceof Error ? e.message : '操作未完成，请重试。'); }
    finally { setBusy(false); }
  };
  const login = (consent = false, codex = false) => run(async () => {
    // Reserve a browser window during the click so normal popup rules allow the official page.
    const opened = window.open('about:blank', '_blank'); popup.current = opened;
    try {
      const result = await value(codex ? api.loginCodex() : consent ? api.consent() : api.login());
      const url = officialLink(result.url); waiting.current = true; setLink(url);
      if (opened) { opened.opener = null; opened.location.replace(url); }
      // Desktop denies blank windows and opens HTTP(S) URLs in the system browser.
      // A null return does not mean its external-browser dispatch failed.
      else window.open(url, '_blank', 'noopener,noreferrer');
    }
    catch (e) { opened?.close(); waiting.current = false; popup.current = null; throw e; }
  });
  const disabled = busy || !view || view.signingIn;
  const loginOptions = <div className="cgp-grid">
    <div className="cgp-card cgp-login"><div><div className="cgp-login-heading"><strong>ChatGPT 登录</strong><span className="cgp-tag">官方授权</span></div><p>推荐 Plus / Pro 会员</p></div><button className="cgp-primary" disabled={disabled} onClick={() => void login()}>使用 ChatGPT 登录</button></div>
    <div className="cgp-card cgp-login"><div><div className="cgp-login-heading"><strong>Business 登录</strong><span className="cgp-tag" title="Codex 兼容连接，非官方路径">兼容 · 实验性</span></div><p>推荐 Business 会员</p></div><button disabled={disabled} onClick={() => void login(false, true)}>使用 Business 登录</button></div>
  </div>;
  return <section className="chatgpt-subscription" aria-label="ChatGPT 订阅">
    <style>{styles}</style>
    <header><h2>ChatGPT 订阅</h2><p className="cgp-subtitle">管理账号连接与订阅额度</p></header>
    <div className="cgp-card cgp-account">
      <div className="cgp-account-main">
        <div className="cgp-avatar" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg></div>
        <div className="cgp-identity"><p className="cgp-email">{view?.account ?? (view ? '连接你的 ChatGPT 账号' : '正在读取账号…')}</p><p className="cgp-path">{view?.state !== 'disconnected' && view ? (view.method === 'codex' ? 'Business 连接 · 实验性' : 'ChatGPT 官方连接') : '选择适合你的订阅连接方式'}</p></div>
        <div className="cgp-account-actions">
          <span className="cgp-status" data-connected={view?.state === 'connected'} role="status"><span className="cgp-dot" />{view?.signingIn ? '等待授权' : view ? labels[view.state] : '读取中'}</span>
          {view && view.state !== 'disconnected' && <button className="cgp-quiet" disabled={disabled} onClick={() => void run(async () => { const r = await value(api.logout()); setLink(''); setModels([]); setUsage(null); setNotice(r.remoteRevoked ? '已退出登录。' : '已退出本地登录；可在 ChatGPT 设置中管理远端连接。'); })}>退出登录</button>}
        </div>
      </div>
    </div>
    {view?.state === 'identity_only' && <div className="cgp-feedback cgp-waiting"><span>开启订阅共享后，即可使用已授权的模型。</span><button className="cgp-primary" disabled={disabled} onClick={() => void login(true)}>启用订阅共享</button></div>}
    {view?.signingIn && <div className="cgp-feedback cgp-waiting" role="status"><span>请在浏览器中完成登录</span>{link && <a href={link} target="_blank" rel="noreferrer noopener">继续授权 ↗</a>}<button className="cgp-quiet" onClick={() => void run(async () => { await value(api.cancel()); waiting.current = false; setLink(''); })}>取消登录</button></div>}
    {(error || stateError || view?.error) && <div className="cgp-feedback" role="alert">{error || stateError || view?.error?.message}{view?.error?.requestId && <small>（请求编号：{view.error.requestId}）</small>}{view?.error?.code === 'AUTH_TEMPORARY' && <button disabled={disabled} onClick={() => void run(refreshModels)}>恢复连接</button>}</div>}
    {notice && <div className="cgp-feedback" role="status">{notice}</div>}
    {view && (view.state === 'disconnected' || view.state === 'reauth_required') ? <div className="cgp-section">{loginOptions}</div> : view && <details className="cgp-switch"><summary>切换连接方式<Chevron /></summary>{loginOptions}</details>}
    {view?.sharing && <div className="cgp-section" aria-label="订阅余量">
      <div className="cgp-section-head"><h3>订阅余量</h3>{view.method === 'codex' && <button className="cgp-quiet" aria-label="刷新用量" disabled={disabled || usageLoading} onClick={() => void refreshUsage()}><Refresh />{usageLoading ? '更新中…' : '刷新'}</button>}</div>
      {view.method === 'codex' ? <>
        {usage?.windows.length ? <div className="cgp-card cgp-usage-panel">{usage.windows.map(w => <UsageCard key={w.id} window={w} />)}</div> : <div className="cgp-card cgp-empty" role="status">{usageLoading ? '正在获取订阅余量…' : '暂时无法获取余量'}</div>}
        {usageError && <p className="cgp-feedback" role="alert">{usageError}</p>}
        {usage?.limitReached && <p className="cgp-feedback" role="alert">当前订阅额度已达上限，请等待重置。</p>}
        {usage && <div className="cgp-updated"><span>更新于 {new Date(usage.observedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span><span>Codex 用量 · 仅供参考</span></div>}
      </> : <div className="cgp-card cgp-empty">此连接暂不提供用量数据，可前往 ChatGPT 查看。</div>}
    </div>}
    {view?.sharing && <details className="cgp-card cgp-models"><summary>可用模型<span className="cgp-count">{modelsLoading ? '加载中' : `${models.length} 个`}</span><Chevron /></summary><div className="cgp-model-body">
      <div className="cgp-model-toolbar"><span>在聊天的模型选择器中切换使用</span><button className="cgp-quiet" disabled={disabled || modelsLoading} onClick={() => void refreshModels()}><Refresh />刷新模型</button></div>
      {modelsError && <p className="cgp-feedback" role="alert">{modelsError}</p>}
      {models.length ? <ul className="cgp-model-list">{models.map(m => <li key={m.id} title={m.id}>{m.name}</li>)}</ul> : <p className="cgp-muted">{modelsLoading ? '正在加载模型…' : '暂无可用模型'}</p>}
    </div></details>}
    <footer className="cgp-footer"><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer noopener">在 ChatGPT 管理订阅 ↗</a></footer>
  </section>;
}
export const inject = ['slots', 'remote'];
export async function apply(ctx: Context): Promise<void> {
  const remote = ctx.get('remote') as TypertClientRemote;
  if (!remote) throw new Error('Harness Remote 服务尚未就绪。');
  await remote.$mount(contribution);
  // Namespace access is a separate Cordis dependency. Capture it in its injected scope,
  // rather than resolving a service later from an unscoped React render.
  ctx.inject(['remote.chatgptProvider'], scope => {
    const api = (scope.get('remote') as TypertClientRemote).chatgptProvider;
    scope.slots.inject('settings.section', () => scope.slots.register({ name: 'settings.section', id: 'chatgpt-subscription', order: 45, label: () => 'ChatGPT 订阅' }, () => <Settings api={api} />));
  });
}
