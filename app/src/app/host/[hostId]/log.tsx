import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Button, Icon, IconButton, Loading, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage, pathKey, randomId } from '@/lib/util';
import { font, radius, space, useColors } from '@/theme';

const MAX_LINES = 3000;
const ASK_MAX_CHARS = 6000;

/** One log: last lines, filter, live follow, and "Ask Claude" about selected lines. */
export default function LogViewer() {
  const c = useColors();
  const { hostId, id, label, project } = useLocalSearchParams<{ hostId: string; id: string; label?: string; project?: string }>();
  const { client } = useConnection(hostId);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [following, setFollowing] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const followId = useRef<string | null>(null);
  const listRef = useRef<FlatList<string>>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const r = await client.call('logs.tail', { id, lines: 1000, ...(applied ? { filter: applied } : {}) });
      setLines(r.text ? r.text.split('\n') : []);
      setError(null);
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err));
      setLines([]);
    }
  }, [client, id, applied]);

  const stopFollow = useCallback(() => {
    if (followId.current) void client?.call('logs.unfollow', { followId: followId.current }).catch(() => undefined);
    followId.current = null;
  }, [client]);

  const startFollow = useCallback(async () => {
    if (!client) return;
    stopFollow();
    try {
      followId.current = (await client.call('logs.follow', { id })).followId;
    } catch (err) {
      setError(errorMessage(err));
      setFollowing(false);
    }
  }, [client, id, stopFollow]);

  // (Re)load, and re-follow after a reconnect (the server drops follows with the connection).
  useOnConnected(
    client,
    useCallback(() => {
      void load();
      if (following) void startFollow();
    }, [load, following, startFollow]),
  );

  useEffect(() => {
    if (!client) return;
    const off = client.on('logs.data', (e) => {
      if (e.followId !== followId.current) return;
      const f = applied.toLowerCase();
      const fresh = e.chunk.split('\n').filter((l, i, all) => (i < all.length - 1 || l !== '') && (!f || l.toLowerCase().includes(f)));
      if (fresh.length) setLines((cur) => [...(cur ?? []), ...fresh].slice(-MAX_LINES));
    });
    return off;
  }, [client, applied]);
  useEffect(() => () => stopFollow(), [stopFollow]);

  const toggleFollow = () => {
    if (following) stopFollow();
    else void startFollow();
    setFollowing((f) => !f);
  };

  const toggleLine = (i: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const ask = () => {
    if (!project || !lines) return;
    const picked = [...selected].sort((a, b) => a - b).map((i) => lines[i]);
    let excerpt = picked.join('\n');
    if (excerpt.length > ASK_MAX_CHARS) excerpt = excerpt.slice(-ASK_MAX_CHARS);
    const text = `These lines are from the log "${label ?? id}". What's going wrong, and can you fix it?\n\n\`\`\`\n${excerpt}\n\`\`\``;
    router.push({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(project), draft: text, draftId: randomId() } });
  };

  const tone = useMemo(
    () => (l: string) => (/\b(error|exception|fatal|crit(ical)?|emerg|panic|failed)\b/i.test(l) ? c.danger : /\bwarn(ing)?\b/i.test(l) ? c.warning : c.text),
    [c],
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: label ?? 'Log',
          headerRight: () => (
            <View style={{ flexDirection: 'row' }}>
              <IconButton icon={wrap ? 'reorder-four-outline' : 'remove-outline'} label={wrap ? 'One line per entry' : 'Wrap lines'} onPress={() => setWrap((w) => !w)} />
              <IconButton icon="refresh" label="Reload" onPress={() => void load()} />
            </View>
          ),
        }}
      />
      <View style={[styles.bar, { borderBottomColor: c.border }]}>
        <View style={[styles.search, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Icon name="search" size={16} color={c.textFaint} />
          <TextInput
            value={filter}
            onChangeText={setFilter}
            onSubmitEditing={() => setApplied(filter.trim())}
            placeholder="Filter, e.g. error"
            placeholderTextColor={c.textFaint}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, color: c.text, paddingVertical: 6 }}
          />
          {applied ? <IconButton icon="close-circle" label="Clear filter" size={16} onPress={() => (setFilter(''), setApplied(''))} /> : null}
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: following }}
          accessibilityLabel="Follow new lines"
          onPress={toggleFollow}
          style={[styles.follow, { backgroundColor: following ? c.successSoft : c.surface2 }]}
        >
          <Icon name={following ? 'radio-button-on' : 'radio-button-off'} size={14} color={following ? c.success : c.textDim} />
          <T size="xs" weight="600">
            Live
          </T>
        </Pressable>
      </View>

      {lines === null ? (
        <Loading />
      ) : (
        <FlatList
          ref={listRef}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          initialScrollIndex={lines.length > 30 ? lines.length - 1 : undefined}
          onScrollToIndexFailed={() => listRef.current?.scrollToEnd({ animated: false })}
          onContentSizeChange={() => following && listRef.current?.scrollToEnd({ animated: true })}
          contentContainerStyle={{ padding: space.sm, paddingBottom: selected.size ? 90 : 24 }}
          ListEmptyComponent={
            <T tone="dim" style={{ textAlign: 'center', marginTop: space.xl }}>
              {error ?? (applied ? `No lines match "${applied}"` : 'This log is empty')}
            </T>
          }
          ListHeaderComponent={
            lines.length && project ? (
              <T size="xs" tone="faint" style={{ marginBottom: space.xs }}>
                Long-press lines to select them, then ask Claude.
              </T>
            ) : null
          }
          renderItem={({ item, index }) => {
            const on = selected.has(index);
            return (
              <Pressable
                onLongPress={() => toggleLine(index)}
                onPress={selected.size ? () => toggleLine(index) : undefined}
                style={[styles.line, on && { backgroundColor: c.accentSoft }]}
              >
                <T mono size="xs" numberOfLines={wrap ? undefined : 1} style={{ color: tone(item), fontFamily: font.mono }}>
                  {item || ' '}
                </T>
              </Pressable>
            );
          }}
        />
      )}

      {selected.size ? (
        <View style={[styles.askBar, { backgroundColor: c.surface, borderTopColor: c.border }]}>
          <T size="sm" weight="600" style={{ flex: 1 }}>
            {selected.size} line{selected.size > 1 ? 's' : ''} selected
          </T>
          <Button small kind="ghost" title="Clear" onPress={() => setSelected(new Set())} />
          {project ? <Button small title="Ask Claude" icon="sparkles-outline" onPress={ask} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.sm },
  follow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, height: 34, borderRadius: radius.pill },
  line: { paddingVertical: 2, paddingHorizontal: 4, borderRadius: 4 },
  askBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderTopWidth: StyleSheet.hairlineWidth },
});
