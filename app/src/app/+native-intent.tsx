/**
 * Deep links that aren't routes: a share from another app arrives as "<scheme>://dataUrl=…"
 * and is handled by expo-share-intent, so show the share screen instead of "not found".
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return path.includes('dataUrl=') ? '/share' : path;
  } catch {
    return '/';
  }
}
