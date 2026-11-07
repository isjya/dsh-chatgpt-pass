import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';

/** Resolve the active shell at click time; its public slot store shares the live settings instance. */
export function openSubscriptionSettings(slots: Pick<SlotRegistry, 'entriesOfSlot'>): void {
  const handle = slots.entriesOfSlot('sidebar.settings')[0]?.store;
  if (!handle || typeof handle === 'function') throw new Error('设置窗口暂不可用。');
  const actions = handle.create().actions;
  if (typeof actions.openSection !== 'function') throw new Error('设置窗口暂不可用。');
  actions.openSection('chatgpt-subscription');
}
