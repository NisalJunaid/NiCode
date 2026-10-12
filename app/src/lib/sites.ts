import type { Site } from '@protocol';

export const KIND_LABEL: Record<Site['kind'], string> = { static: 'Static site', spa: 'Web app (SPA)', php: 'PHP', proxy: 'App on a port', unknown: 'Custom' };

export function certBadge(site: Site): { text: string; tone: 'success' | 'warning' | 'danger' | 'default' } {
  if (!site.https) return { text: 'http only', tone: 'default' };
  if (!site.certExpiresAt) return { text: 'HTTPS', tone: 'success' };
  const days = Math.round((Date.parse(site.certExpiresAt) - Date.now()) / 86_400_000);
  if (days < 0) return { text: 'Certificate expired', tone: 'danger' };
  if (days < 14) return { text: `HTTPS · renews in ${days}d`, tone: 'warning' };
  return { text: 'HTTPS', tone: 'success' };
}
