import type { AppProcess } from '@protocol';

export function appTone(a: AppProcess): { dot: 'ok' | 'busy' | 'off' | 'bad'; label: string } {
  if (a.status === 'online' && a.listening === false) return { dot: 'busy', label: `Running · port ${a.port} not answering` };
  if (a.status === 'online') return { dot: 'ok', label: a.port ? `Running · port ${a.port}` : 'Running' };
  if (a.status === 'errored') return { dot: 'bad', label: 'Crashed' };
  if (a.status === 'stopped') return { dot: 'off', label: 'Stopped' };
  return { dot: 'busy', label: a.status };
}

export function uptime(since: string | null): string {
  if (!since) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
