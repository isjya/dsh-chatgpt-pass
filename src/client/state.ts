import type { SessionView } from '../auth/session.js';
import type { UsageView } from '../llm/usage.js';
import { type Api, value } from './api.js';
import { SidebarPreference } from './preferences.js';

export function connectionKey(view?: SessionView): string {
  return view?.state === 'connected' && view.sharing && !view.signingIn ? `${view.method}:${view.account ?? ''}` : '';
}
export interface ClientSnapshot {
  view?: SessionView;
  stateError: string;
  usage: UsageView | null;
  usageLoading: boolean;
  usageError: string;
  now: number;
}
const empty = (): ClientSnapshot => ({ stateError: '', usage: null, usageLoading: false, usageError: '', now: Date.now() });

/** One account/quota reader shared by settings and the optional sidebar card. */
export class ClientState {
  readonly sidebar: SidebarPreference;
  private snapshot = empty();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private usageEpoch = 0;
  private viewPending?: Promise<void>;
  private usagePending?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastUsageAttempt = 0;
  private lastViewAttempt = 0;
  private settingsReaders = 0;
  private disposed = false;

  constructor(readonly api: Api, sidebar: SidebarPreference) { this.sidebar = sidebar; }
  getSnapshot = (): ClientSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => this.retain(listener, true);
  subscribeSidebar = (listener: () => void): (() => void) => this.retain(listener, false);
  private retain(listener: () => void, settings: boolean): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    if (settings) this.settingsReaders++;
    if (this.listeners.size === 1) {
      void this.refreshView();
      this.poll = setInterval(() => {
        if (!this.visible()) return;
        this.patch({ now: Date.now() });
        const interval = this.settingsReaders || this.snapshot.view?.signingIn ? 2000 : 15000;
        const view = Date.now() - this.lastViewAttempt >= interval ? this.refreshView() : Promise.resolve();
        void view.then(() => {
          if (Date.now() - this.lastUsageAttempt >= 60000) void this.refreshUsage();
        });
      }, 2000);
      if (typeof window !== 'undefined') window.addEventListener('focus', this.onFocus);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onFocus);
    } else if (settings) void this.refreshView();
    let released = false;
    return () => {
      if (released) return;
      released = true; this.listeners.delete(listener);
      if (settings) this.settingsReaders--;
      if (!this.listeners.size) this.stop();
    };
  }
  private visible(): boolean { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }
  private onFocus = (): void => {
    if (this.visible()) void this.refreshView().then(() => {
      if (Date.now() - this.lastUsageAttempt >= 60000) void this.refreshUsage();
    });
  };
  private patch(next: Partial<ClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  private clearUsage(): void {
    this.usageEpoch++;
    clearTimeout(this.retry); this.retry = undefined;
    this.usagePending = undefined; this.lastUsageAttempt = 0;
    this.patch({ usage: null, usageLoading: false, usageError: '' });
  }
  /** Drop results from the previous connection before a local sign-in/sign-out action. */
  invalidate(): void {
    this.epoch++; this.viewPending = undefined;
    this.clearUsage(); this.patch({ view: undefined, stateError: '' });
  }
  refreshView = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.viewPending) return this.viewPending;
    const epoch = this.epoch;
    this.lastViewAttempt = Date.now();
    const pending = (async () => {
      try {
        const view = await value(this.api.view());
        if (epoch !== this.epoch || this.disposed) return;
        const changed = connectionKey(view) !== connectionKey(this.snapshot.view);
        if (changed) this.clearUsage();
        this.patch({ view, stateError: '' });
        if (changed && view.method === 'codex' && connectionKey(view)) void this.refreshUsage(true);
      } catch { if (epoch === this.epoch && !this.disposed) this.patch({ stateError: '暂时无法读取连接状态。' }); }
    })().finally(() => { if (this.viewPending === pending) this.viewPending = undefined; });
    this.viewPending = pending;
    return pending;
  };
  refreshUsage = (retryOnce = false): Promise<void> => {
    if (this.disposed || !connectionKey(this.snapshot.view) || this.snapshot.view?.method !== 'codex') return Promise.resolve();
    if (this.usagePending) return this.usagePending;
    if (this.snapshot.stateError) { this.patch({ usageLoading: false }); return Promise.resolve(); }
    clearTimeout(this.retry); this.retry = undefined;
    const epoch = this.epoch, generation = this.usageEpoch;
    const current = () => !this.disposed && epoch === this.epoch && generation === this.usageEpoch;
    this.lastUsageAttempt = Date.now();
    this.patch({ usageLoading: true, usageError: '' });
    let retrying = false;
    const pending = (async () => {
      try {
        const usage = await value(this.api.usage());
        if (current()) this.patch({ usage, now: Date.now(), usageError: '' });
      } catch {
        if (!current()) return;
        if (retryOnce) { retrying = true; this.retry = setTimeout(() => { this.retry = undefined; void this.refreshUsage(); }, 1000); }
        else this.patch({ usageError: '用量暂时无法更新，请重试。' });
      } finally { if (current() && !retrying) this.patch({ usageLoading: false }); }
    })().finally(() => { if (this.usagePending === pending) this.usagePending = undefined; });
    this.usagePending = pending;
    return pending;
  };
  private stop(): void {
    clearInterval(this.poll); this.poll = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('focus', this.onFocus);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onFocus);
    this.invalidate();
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); this.stop(); }
}
