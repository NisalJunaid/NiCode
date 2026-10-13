import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import type { GitBackup, GitCommit } from '@protocol';
import { EmptyState, Icon, Loading, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage, relativeTime } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

const PAGE = 40;

/** A project's commits (newest first). Tap one to see it, or restore the code to it. */
export default function History() {
  const c = useColors();
  const { hostId, project } = useLocalSearchParams<{ hostId: string; project: string }>();
  const { client } = useConnection(hostId);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [backups, setBackups] = useState<GitBackup[]>([]);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [list, bk] = await Promise.all([client.call('git.log', { projectPath: project, limit: PAGE }), client.call('git.backups', { projectPath: project }).catch(() => [])]);
      setCommits(list);
      setBackups(bk);
      setMore(list.length === PAGE);
    } catch (err) {
      setError(errorMessage(err));
      setCommits([]);
    }
  }, [client, project]);
  useOnConnected(client, load);
  useFocusEffect(
    useCallback(() => {
      if (client?.state === 'open') void load();
    }, [client, load]),
  );

  const loadMore = async () => {
    if (!client || !commits || !more || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await client.call('git.log', { projectPath: project, limit: PAGE, skip: commits.length });
      setCommits([...commits, ...next]);
      setMore(next.length === PAGE);
    } finally {
      setLoadingMore(false);
    }
  };

  if (!commits) return <Loading />;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: `History · ${basename(project)}` }} />
      <FlatList
        data={commits}
        keyExtractor={(x) => x.hash}
        contentContainerStyle={{ padding: space.lg, paddingBottom: 40 }}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          backups.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/host/[hostId]/commit', params: { hostId, project, backups: '1' } })}
              style={({ pressed }) => [styles.backups, { backgroundColor: pressed ? c.surfacePressed : c.accentSoft }]}
            >
              <Icon name="shield-checkmark-outline" size={18} color={c.accent} />
              <View style={{ flex: 1 }}>
                <T weight="600">Restore points</T>
                <T size="xs" tone="dim">
                  {backups.length} saved before earlier restores · tap to undo one
                </T>
              </View>
              <Icon name="chevron-forward" size={16} color={c.textDim} />
            </Pressable>
          ) : null
        }
        ListEmptyComponent={<EmptyState icon="git-commit-outline" title={error ? "Couldn't load history" : 'No commits yet'} body={error ?? undefined} />}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={c.accent} style={{ marginTop: space.md }} /> : null}
        renderItem={({ item, index }) => {
          const head = item.refs?.some((r) => r.startsWith('HEAD'));
          const branchRefs = (item.refs ?? []).map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD');
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/host/[hostId]/commit', params: { hostId, project, hash: item.hash } })}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surfacePressed }]}
            >
              <View style={styles.rail}>
                <View style={[styles.line, { backgroundColor: index === 0 ? 'transparent' : c.border }]} />
                <View style={[styles.dot, { borderColor: head ? c.accent : c.textFaint, backgroundColor: head ? c.accent : c.bg }]} />
                <View style={[styles.line, { backgroundColor: index === commits.length - 1 ? 'transparent' : c.border }]} />
              </View>
              <View style={{ flex: 1, paddingVertical: space.sm, gap: 2 }}>
                <T weight="600" numberOfLines={2}>
                  {item.message}
                </T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  <T size="xs" tone="dim" mono>
                    {item.hash.slice(0, 7)}
                  </T>
                  <T size="xs" tone="dim">
                    {item.author} · {relativeTime(item.date)}
                  </T>
                  {item.pushed === false ? <Icon name="cloud-offline-outline" size={12} color={c.warning} /> : item.pushed ? <Icon name="cloud-done-outline" size={12} color={c.textFaint} /> : null}
                  {branchRefs.slice(0, 3).map((r) => (
                    <View key={r} style={[styles.ref, { backgroundColor: r.startsWith('tag:') ? c.warningSoft : c.accentSoft }]}>
                      <T size="xs" weight="600" tone={r.startsWith('tag:') ? 'warning' : 'accent'}>
                        {r.replace(/^tag: /, '')}
                      </T>
                    </View>
                  ))}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, borderRadius: radius.md, paddingRight: space.sm },
  rail: { width: 16, alignItems: 'center' },
  line: { width: 2, flex: 1 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  ref: { borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  backups: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.lg, marginBottom: space.md },
});
