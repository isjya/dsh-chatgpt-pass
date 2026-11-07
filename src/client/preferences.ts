import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';

export interface DisplayPreferences { showSidebarQuota: boolean }
export type PreferenceForm = Pick<ConfigForm<DisplayPreferences>, 'getSnapshot' | 'subscribe' | 'set'>;

/** Persist the display boolean in the Host configuration, independent of the browser's origin. */
export class SidebarPreference {
  constructor(private readonly form: PreferenceForm) {}
  getSnapshot = (): ConfigFormSnapshot<DisplayPreferences> => this.form.getSnapshot();
  subscribe = (listener: () => void): (() => void) => this.form.subscribe(listener);
  set = async (enabled: boolean): Promise<void> => {
    if (!await this.form.set('showSidebarQuota', enabled)) throw new Error('显示设置未保存，请重试。');
  };
}
