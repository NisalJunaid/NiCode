import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { FsEntry, SearchMatch } from '@protocol';
import { ConnectionBar } from '@/components/ConnectionBar';
import { Divider, EmptyState, Field, type IconName, Icon, Loading, Row, T } from '@/components/ui';
import { useProject } from '@/lib/project';
import { useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

const ICONS: Record<string, IconName> = {
  ts: 'logo-javascript', tsx: 'logo-react', js: 'logo-javascript', jsx: 'logo-react', json: 'code-slash-outline', md: 'document-text-outline',
  php: 'code-slash-outline', py: 'logo-python', html: 'logo-html5', css: 'logo-css3', scss: 'logo-css3', vue: 'logo-vue', go: 'code-slash-outline',
  png: 'image-outline', jpg: 'image-outline', jpeg: 'image-outline', svg: 'image-outline', gif: 'image-outline', lock: 'lock-closed-outline', env: 'key-outline',
};
function fileIcon(e: FsEntry): IconName {
  if (e.type === 'dir') return 'folder';
  if (e.name.startsWith('.env')) return 'key-outline';
  return ICONS[e.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'document-outline';
}

export default function Files() {
  const c = useColors();
  const { hostId, projectPath } = useProject();
  const { client, state, error } = useConnection(hostId);
  const [dir, setDirState] = useState('');
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setEntries(await client.call('fs.list', { projectPath, dir }));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [client, projectPath, dir]);
  // Runs on connect and again whenever `load` changes (i.e. when the folder changes).
  useOnConnected(client, load);
  const setDir = (d: string) => {
    setEntries(null);
    setDirState(d);
  };

  // Live refresh when Claude (or anyone) changes files in this folder.
  useEffect(() => {
    if (!client) return;
    return client.on('fs.changed', (d) => {
      if (d.projectPath !== projectPath) return;
      if (d.paths.some((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') === dir)) void load();
    });
  }, [client, projectPath, dir, load]);

  const search = async () => {
    if (!client || !query.trim()) return setResults(null);
    setSearching(true);
    try {
      setResults(await client.call('fs.search', { projectPath, query: query.trim(), maxResults: 200 }));
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const openFile = (path: string, line?: number) =>
    router.push({ pathname: '/host/[hostId]/file', params: { hostId, project: projectPath, path, ...(line ? { line: String(line) } : {}) } });

  const crumbs = dir ? dir.split('/') : [];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ConnectionBar client={client} state={state} error={error} />
      <View style={{ padding: space.md, gap: space.sm }}>
        <Field
          placeholder="Search in files"
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            if (!t) setResults(null);
          }}
          onSubmitEditing={search}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {results === null ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4, alignItems: 'center' }}>
            <Crumb label="Project" onPress={() => setDir('')} active={!dir} />
            {crumbs.map((part, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="chevron-forward" size={12} color={c.textFaint} />
                <Crumb label={part} active={i === crumbs.length - 1} onPress={() => setDir(crumbs.slice(0, i + 1).join('/'))} />
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>

      {results !== null ? (
        <FlatList
          data={results}
          keyExtractor={(m, i) => `${m.path}:${m.line}:${i}`}
          ItemSeparatorComponent={Divider}
          ListEmptyComponent={searching ? <Loading /> : <EmptyState icon="search-outline" title="No matches" />}
          renderItem={({ item }) => (
            <Row title={item.path} subtitle={`${item.line}: ${item.preview.trim()}`} mono icon="document-text-outline" onPress={() => openFile(item.path, item.line)} />
          )}
        />
      ) : entries === null ? (
        loadError ? <EmptyState icon="alert-circle-outline" title="Couldn't open folder" body={loadError} /> : <Loading />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.path}
          ItemSeparatorComponent={Divider}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
          ListHeaderComponent={
            dir ? <Row icon="arrow-up" title=".." subtitle="Up one folder" onPress={() => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')} chevron={false} /> : null
          }
          ListEmptyComponent={<EmptyState icon="folder-open-outline" title="Empty folder" />}
          renderItem={({ item }) => (
            <Row
              icon={fileIcon(item)}
              iconColor={item.type === 'dir' ? c.accent : undefined}
              title={item.name}
              subtitle={item.ignored ? 'ignored by git' : undefined}
              chevron={item.type === 'dir'}
              onPress={() => (item.type === 'dir' ? setDir(item.path) : openFile(item.path))}
            />
          )}
        />
      )}
    </View>
  );
}

function Crumb({ label, onPress, active }: { label: string; onPress: () => void; active: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={8} style={[styles.crumb, { backgroundColor: active ? c.accentSoft : c.surface2 }]}>
      <T size="sm" weight={active ? '600' : '500'} style={{ color: active ? c.accent : c.textDim }} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  crumb: { paddingHorizontal: space.md, height: 30, borderRadius: radius.pill, justifyContent: 'center' },
});
