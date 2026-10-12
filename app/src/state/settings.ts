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
  /** Colour theme. Dark unless the user picks otherwise. */
  appearance: 'dark' | 'light' | 'system';
  /** Last preview source per project path. */
  lastPreview: Record<string, 'dev' | 'app' | 'domain'>;
  set(patch: Partial<Omit<SettingsState, 'set'>>): void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      graceSeconds: 300,
      defaultMode: 'default',
      defaultModel: '',
      appearance: 'dark',
      lastPreview: {},
      set: (patch) => set(patch),
    }),
    { name: 'nicode.settings', storage: kvStorage },
  ),
);
