import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import type { AppProcess, AppsStatus } from '@protocol';
import { AppCard, Pm2Setup } from '@/components/AppCard';
import { EmptyState, Loading, T } from '@/components/ui';
import { useConnection } from '@/lib/connections';
import { space, useColors } from '@/theme';

/** Every pm2 app on the server, across projects. */
export default function Apps() {
  const c = useColors();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { client, state } = useConnection(hostId);
  const [status, setStatus] = useState<AppsStatus | null>(null);
  const [apps, setApps] = useState<AppProcess[] | null>(null);

  const load = useCallback(async () => {
    if (!client || client.state !== 'open') return;
    const [st, list] = await Promise.all([client.call('apps.status', {}).catch(() => null), client.call('apps.list', {}).catch(() => [])]);
    setStatus(st);
    setApps(list);
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(() => void load(), 5000);
      return () => clearInterval(t);
    }, [load]),
  );

  if (!status || !apps) return state === 'open' ? <Loading /> : null;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
    >
      {client ? <Pm2Setup client={client} status={status} onDone={(s) => { setStatus(s); void load(); }} /> : null}
      <T size="sm" tone="dim">
        {status.pm2 ? `pm2 ${status.pm2} · ${status.node ?? 'node ?'}${status.startupEnabled ? ' · starts on boot' : ''}` : 'pm2 is not installed yet.'}
      </T>
      {apps.length === 0 ? (
        <EmptyState icon="play-circle-outline" title="No apps running" body="Open a project's Run tab and choose “Run as an app”." />
      ) : (
        apps.map((a) => <AppCard key={a.name} hostId={hostId} client={client!} app={a} onChanged={load} showProject />)
      )}
    </ScrollView>
  );
}
