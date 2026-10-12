import { Platform, useColorScheme } from 'react-native';

/** Design tokens. Dark-first; every color has a light counterpart. */
const dark = {
  bg: '#0E1015',
  surface: '#161922',
  surface2: '#1E222D',
  surfacePressed: '#252A37',
  border: '#2A2F3B',
  text: '#E8EAF0',
  textDim: '#9AA3B5',
  textFaint: '#6B7385',
  accent: '#7C9CFF',
  accentPressed: '#6A88EE',
  onAccent: '#0B1020',
  accentSoft: 'rgba(124,156,255,0.14)',
  success: '#4ADE80',
  successSoft: 'rgba(74,222,128,0.14)',
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.14)',
  danger: '#F87171',
  dangerSoft: 'rgba(248,113,113,0.14)',
  userBubble: '#24304D',
  codeBg: '#0A0C10',
  diffAdd: 'rgba(74,222,128,0.13)',
  diffDel: 'rgba(248,113,113,0.13)',
  overlay: 'rgba(0,0,0,0.55)',
};

const light: typeof dark = {
  bg: '#F6F7FB',
  surface: '#FFFFFF',
  surface2: '#EEF0F6',
  surfacePressed: '#E3E6EE',
  border: '#DDE1EA',
  text: '#141824',
  textDim: '#5B6478',
  textFaint: '#8A93A6',
  accent: '#3B5BDB',
  accentPressed: '#3350C4',
  onAccent: '#FFFFFF',
  accentSoft: 'rgba(59,91,219,0.10)',
  success: '#16A34A',
  successSoft: 'rgba(22,163,74,0.10)',
  warning: '#B45309',
  warningSoft: 'rgba(180,83,9,0.10)',
  danger: '#DC2626',
  dangerSoft: 'rgba(220,38,38,0.10)',
  userBubble: '#E3E9FF',
  codeBg: '#F1F3F8',
  diffAdd: 'rgba(22,163,74,0.12)',
  diffDel: 'rgba(220,38,38,0.10)',
  overlay: 'rgba(15,20,35,0.35)',
};

export type Colors = typeof dark;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;
export const font = {
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  size: { xs: 12, sm: 13, md: 15, lg: 17, xl: 20, xxl: 26 },
} as const;
/** Minimum touch target (iOS HIG 44pt / Material 48dp). */
export const HIT = 44;

export function useColors(): Colors {
  return useColorScheme() === 'light' ? light : dark;
}

export function useIsDark(): boolean {
  return useColorScheme() !== 'light';
}
