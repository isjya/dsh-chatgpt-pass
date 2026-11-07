import { afterEach, expect, it, vi } from 'vitest';
import type { SessionView } from '../src/auth/session.js';
import type { UsageView } from '../src/llm/usage.js';
import type { Api } from '../src/client/api.js';
import { ClientState } from '../src/client/state.js';
import { SidebarPreference } from '../src/client/preferences.js';

const connected: SessionView = { state: 'connected', sharing: true, signingIn: false, method: 'codex', account: 's***@example.com' };
const quota: UsageView = { limitReached: false, observedAt: 1800000000000, windows: [{ id: '5h', label: '5 小时窗口', usedPercent: 16 }] };
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
function preferenceForm() {
  let snapshot = { status: 'ready' as const, value: { showSidebarQuota: false }, writable: true, revision: 0, base: {}, user: {} };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: vi.fn(async (field: string, value: unknown) => {
      snapshot = { ...snapshot, value: { showSidebarQuota: value === true }, user: { [field]: value }, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
      return true;
    }),
  };
}
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(quota.observedAt);
  let view = { ...connected };
  const api = { view: vi.fn(() => ok({ ...view })), usage: vi.fn(() => ok(quota)), models: vi.fn(() => ok([])), cancel: vi.fn(() => ok(undefined)) };
  const client = new ClientState(api as unknown as Api, new SidebarPreference(preferenceForm()));
  clients.push(client);
  return { client, api, setView: (next: SessionView) => { view = next; } };
}
const clients: ClientState[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

it('defaults the sidebar off and persists only the display boolean through Host settings', async () => {
  const form = preferenceForm();
  const preference = new SidebarPreference(form), changed = vi.fn();
  const release = preference.subscribe(changed);
  expect(preference.getSnapshot().value?.showSidebarQuota).toBe(false);
  await preference.set(true);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(new SidebarPreference(form).getSnapshot().value?.showSidebarQuota).toBe(true);
  expect(form.set).toHaveBeenCalledWith('showSidebarQuota', true);
  release(); await preference.set(false);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('reports a refused preference write without enabling an unsaved card', async () => {
  const form = preferenceForm(), preference = new SidebarPreference(form);
  form.set.mockResolvedValueOnce(false);
  await expect(preference.set(true)).rejects.toThrow('未保存');
  expect(preference.getSnapshot().value?.showSidebarQuota).toBe(false);
});

it('shares reads between settings and sidebar without loading a model catalog', async () => {
  const { client, api } = fixture();
  const sidebar = client.subscribeSidebar(() => {}), settings = client.subscribe(() => {});
  await flush();
  expect(api.view).toHaveBeenCalledTimes(1); expect(api.usage).toHaveBeenCalledTimes(1);
  expect(client.getSnapshot().usage).toEqual(quota); expect(api.models).not.toHaveBeenCalled();
  settings(); await vi.advanceTimersByTimeAsync(10000);
  expect(api.view).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50000);
  expect(api.usage).toHaveBeenCalledTimes(2);
  sidebar(); await vi.advanceTimersByTimeAsync(120000);
  expect(api.usage).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  expect(api.cancel).not.toHaveBeenCalled();
});

it('waits for authorization to settle and never reads quota for an official connection', async () => {
  const { client, api, setView } = fixture();
  setView({ ...connected, signingIn: true }); client.subscribe(() => {}); await flush();
  expect(api.usage).not.toHaveBeenCalled();
  setView({ ...connected, method: 'siwc' }); await client.refreshView();
  expect(api.usage).not.toHaveBeenCalled(); expect(client.getSnapshot().usage).toBeNull();
  setView(connected); await client.refreshView(); await flush();
  expect(api.usage).toHaveBeenCalledTimes(1);
});

it('drops an old in-flight quota response after sign-out or account replacement', async () => {
  const { client, api, setView } = fixture();
  let finish!: (result: Awaited<ReturnType<Api['usage']>>) => void;
  api.usage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as ReturnType<typeof api.usage>);
  client.subscribe(() => {}); await flush();
  client.invalidate();
  setView({ state: 'disconnected', sharing: false, signingIn: false, method: 'siwc' });
  await client.refreshView(); finish({ ok: true, value: quota }); await flush();
  expect(client.getSnapshot().usage).toBeNull(); expect(client.getSnapshot().usageLoading).toBe(false);
  setView({ ...connected, account: 'b***@example.net' }); await client.refreshView(); await flush();
  expect(api.usage).toHaveBeenCalledTimes(2); expect(client.getSnapshot().usage).toEqual(quota);
});

it('retries the initial quota read once, then cancels retries when no view is mounted', async () => {
  const { client, api } = fixture();
  api.usage.mockRejectedValueOnce(new Error('temporary'));
  const release = client.subscribeSidebar(() => {}); await flush();
  expect(client.getSnapshot().usageLoading).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.usage).toHaveBeenCalledTimes(2); expect(client.getSnapshot().usageError).toBe('');
  client.invalidate(); api.usage.mockRejectedValueOnce(new Error('temporary'));
  await client.refreshView(); await flush(); release(); await vi.advanceTimersByTimeAsync(1000);
  expect(api.usage).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
});

it('retains the last observation on failure and clears the stale hint after recovery', async () => {
  const { client, api } = fixture(); client.subscribe(() => {}); await flush();
  api.usage.mockRejectedValueOnce(new Error('temporary')); await client.refreshUsage();
  expect(client.getSnapshot().usage).toEqual(quota); expect(client.getSnapshot().usageError).not.toBe('');
  await client.refreshUsage(); expect(client.getSnapshot().usageError).toBe('');
  api.view.mockRejectedValueOnce(new Error('temporary')); await client.refreshView();
  expect(client.getSnapshot().stateError).not.toBe(''); expect(client.getSnapshot().usage).toEqual(quota);
  await client.refreshView(); expect(client.getSnapshot().stateError).toBe('');
});

it('ignores late reads after plugin disposal and releases every timer', async () => {
  const { client, api } = fixture();
  let finish!: (result: Awaited<ReturnType<Api['view']>>) => void;
  api.view.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as ReturnType<typeof api.view>);
  client.subscribeSidebar(() => {}); client.dispose(); finish({ ok: true, value: connected }); await flush();
  expect(client.getSnapshot().view).toBeUndefined(); expect(api.usage).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
