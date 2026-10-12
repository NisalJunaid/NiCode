import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PermissionMode } from '@protocol';
import { kvStorage } from '@/lib/storage';

interface SettingsState {
  /** Seconds the unlocked key stays usable after a biometric check. 0 = ask every time. */
  graceSeconds: number;
  /** Defaults for new chats. */
  defaultMode: PermissionMode;
  defaultModel: string;
  set(patch: Partial<Omit<SettingsState, 'set'>>): void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      graceSeconds: 300,
      defaultMode: 'default',
      defaultModel: '',
      set: (patch) => set(patch),
    }),
    { name: 'nicode.settings', storage: kvStorage },
  ),
);
