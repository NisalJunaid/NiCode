import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import type { LogSource } from '@protocol';
import { Divider, EmptyState, type IconName, Loading, Row, Section } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage } from '@/lib/util';
import { space, useColors } from '@/theme';

const GROUPS: { group: LogSource['group']; title: string; icon: IconName }[] = [
  { group: 'project', title: 'Projects', icon: 'folder-outline' },
  { group: 'pm2', title: 'Apps (pm2)', icon: 'cube-outline' },
  { group: 'nginx', title: 'Websites (nginx)', icon: 'globe-outline' },
  { group: 'system', title: 'Server', icon: 'server-outline' },
];

/** Every log niCode can show on this server (or just one project's), grouped. */
export default function Logs() {
  const c = useColors();
  const { hostId, project } = useLocalSearchParams<{ hostId: string; project?: string }>();
  const { client } = useConnection(hostId);
  const [sources, setSources] = useState<LogSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setSources(await client.call('logs.sources', project ? { projectPath: project } : {}));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setSources([]);
    }
  }, [client, project]);
  useOnConnected(client, load);

  if (!sources) return <Loading />;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
    >
      <Stack.Screen options={{ title: project ? `Logs · ${basename(project)}` : 'Logs' }} />
      {sources.length === 0 ? (
        <EmptyState
          icon="document-text-outline"
          title={error ? "Couldn't load logs" : 'No logs found'}
          body={error ?? (project ? 'Logs appear here once the project runs as an app, has a domain, or writes Laravel logs.' : undefined)}
        />
      ) : (
        GROUPS.map(({ group, title, icon }) => {
          const items = sources.filter((s) => s.group === group);
          if (!items.length) return null;
          return (
            <Section key={group} title={title}>
              {items.map((s, i) => (
                <View key={s.id}>
                  {i > 0 ? <Divider /> : null}
                  <Row
                    icon={icon}
                    title={s.label}
                    subtitle={s.detail}
                    onPress={() => router.push({ pathname: '/host/[hostId]/log', params: { hostId, id: s.id, label: s.label, ...(s.projectPath ? { project: s.projectPath } : project ? { project } : {}) } })}
                  />
                </View>
              ))}
            </Section>
          );
        })
      )}
    </ScrollView>
  );
}
