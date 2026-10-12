import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import type { Project } from '@protocol';
import { ConnectionBar } from '@/components/ConnectionBar';
import { Banner, Button, Divider, EmptyState, Field, IconButton, Loading, Row, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { registerPush } from '@/lib/push';
import { errorMessage, pathKey, relativeTime } from '@/lib/util';
import { useHost } from '@/state/hosts';
import { radius, space, useColors } from '@/theme';

export default function Projects() {
  const c = useColors();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const host = useHost(hostId);
  const { client, state, info, error } = useConnection(hostId);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [domains, setDomains] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setProjects(await client.call('projects.list', {}));
      setLoadError(null);
      // Best effort: which projects have live domains (needs nginx; silently skipped otherwise).
      const st = await client.call('sites.status', {}).catch(() => null);
      if (st?.supported) {
        const sites = await client.call('sites.list', {}).catch(() => []);
        const map: Record<string, string[]> = {};
        for (const s of sites) if (s.projectPath && s.enabled && s.domains[0]) (map[s.projectPath] ??= []).push(s.domains[0]);
        setDomains(map);
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [client]);

  useOnConnected(
    client,
    useCallback(() => {
      void load();
      if (client) void registerPush(client);
    }, [load, client]),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [projects, query]);

  if (!host) return <EmptyState icon="alert-circle-outline" title="Server not found" />;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      {info && !info.setup.claude ? (
        <Banner
          tone="warning"
          icon="key-outline"
          title="Claude isn't logged in on this server"
          body="Log in once with your Claude subscription to start coding."
          action={<Button small title="Log in to Claude" onPress={() => router.push({ pathname: '/host/[hostId]/claude-login', params: { hostId } })} />}
        />
      ) : null}
      {client?.protocolMismatch ? (
        <Banner tone="warning" icon="arrow-up-circle-outline" title="Server update recommended" body="Run `sudo nicode update` on the server so it matches this app." />
      ) : null}
      {projects && projects.length > 6 ? (
        <Field placeholder="Search projects" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" />
      ) : null}
      {projects && projects.length > 0 ? (
        <T size="sm" tone="dim">
          {info?.projectsRoot ?? 'Projects'}
        </T>
      ) : null}
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: host.name,
          headerRight: () => (
            <IconButton icon="settings-outline" label="Server settings" onPress={() => router.push({ pathname: '/host/[hostId]/server', params: { hostId } })} />
          ),
        }}
      />
      <ConnectionBar client={client} state={state} error={error} />
      {projects === null && !loadError ? (
        state === 'open' ? <Loading label="Loading projects…" /> : null
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.path}
          contentContainerStyle={{ padding: space.lg }}
          ListHeaderComponent={header}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={c.accent}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ItemSeparatorComponent={Divider}
          renderItem={({ item, index }) => (
            <View
              style={{
                backgroundColor: c.surface,
                borderTopLeftRadius: index === 0 ? radius.lg : 0,
                borderTopRightRadius: index === 0 ? radius.lg : 0,
                borderBottomLeftRadius: index === filtered.length - 1 ? radius.lg : 0,
                borderBottomRightRadius: index === filtered.length - 1 ? radius.lg : 0,
                overflow: 'hidden',
              }}
            >
              <Row
                icon={item.isGit ? 'git-branch-outline' : 'folder-outline'}
                title={item.name}
                subtitle={[domains[item.path]?.join(', '), item.branch, item.lastOpenedAt ? `used ${relativeTime(item.lastOpenedAt)}` : null].filter(Boolean).join(' · ') || undefined}
                onPress={() => router.push({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(item.path) } })}
              />
            </View>
          )}
          ListEmptyComponent={
            loadError ? (
              <EmptyState icon="alert-circle-outline" title="Couldn't load projects" body={loadError} action={<Button small title="Try again" onPress={load} />} />
            ) : query ? (
              <EmptyState icon="search-outline" title={`No project matches "${query}"`} />
            ) : (
              <EmptyState icon="folder-open-outline" title="No projects yet" body={`Add a folder or clone a repo into ${info?.projectsRoot ?? 'the projects folder'}.`} />
            )
          }
          ListFooterComponent={
            state === 'open' ? (
              <View style={{ marginTop: space.lg }}>
                <Button
                  title="New project or clone"
                  icon="add"
                  kind="secondary"
                  onPress={() => router.push({ pathname: '/host/[hostId]/new-project', params: { hostId } })}
                />
                {info && !info.setup.github ? (
                  <T size="sm" tone="faint" style={{ textAlign: 'center', marginTop: space.sm }}>
                    Tip: connect GitHub in Server settings to clone private repos.
                  </T>
                ) : null}
              </View>
            ) : null
          }
        />
      )}
    </>
  );
}
