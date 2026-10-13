import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { TabKeyboardAvoidingView } from '@/components/TabKeyboardAvoidingView';
import type { GitFileStatus, GitStatus } from '@protocol';
import { ConnectionBar } from '@/components/ConnectionBar';
import { Badge, Button, EmptyState, Icon, Loading, T } from '@/components/ui';
import { useProject } from '@/lib/project';
import { useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage } from '@/lib/util';
import { font, radius, space, useColors } from '@/theme';

const LABEL: Record<string, { text: string; tone: 'success' | 'warning' | 'danger' | 'accent' | 'default' }> = {
  M: { text: 'Modified', tone: 'warning' },
  A: { text: 'Added', tone: 'success' },
  D: { text: 'Deleted', tone: 'danger' },
  R: { text: 'Renamed', tone: 'accent' },
  '?': { text: 'New', tone: 'success' },
  U: { text: 'Conflict', tone: 'danger' },
};

export default function Changes() {
  const c = useColors();
  const { hostId, projectPath } = useProject();
  const { client, state, error } = useConnection(hostId);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setStatus(await client.call('git.status', { projectPath }));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [client, projectPath]);
  useOnConnected(client, load);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => client?.on('fs.changed', (d) => d.projectPath === projectPath && void load()), [client, projectPath, load]);

  const act = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      const r = await fn();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (success) Alert.alert(success, typeof r === 'object' && r && 'output' in r ? String((r as { output: string }).output).slice(-600) || undefined : undefined);
      await load();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(`${label} failed`, errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !status) {
    const notGit = /not a git repository/i.test(loadError);
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ConnectionBar client={client} state={state} error={error} />
        <EmptyState
          icon="git-branch-outline"
          title={notGit ? 'Not a git repository' : 'Couldn\'t read changes'}
          body={notGit ? 'Ask Claude to "initialise git and make a first commit" to track changes here.' : loadError}
        />
      </View>
    );
  }
  if (!status) return <Loading />;

  const staged = status.files.filter((f) => f.index !== ' ' && f.index !== '?');
  const unstaged = status.files.filter((f) => f.workingDir !== ' ' || f.index === '?');
  const openDiff = (f: GitFileStatus, isStaged: boolean) =>
    router.push({ pathname: '/host/[hostId]/diff', params: { hostId, project: projectPath, path: f.path, staged: isStaged ? '1' : '' } });

  const fileMenu = (f: GitFileStatus, isStaged: boolean) =>
    Alert.alert(f.path, undefined, [
      isStaged
        ? { text: 'Unstage', onPress: () => void act('Unstage', () => client!.call('git.unstage', { projectPath, paths: [f.path] })) }
        : { text: 'Stage', onPress: () => void act('Stage', () => client!.call('git.stage', { projectPath, paths: [f.path] })) },
      {
        text: 'Discard changes',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Discard changes?', `This permanently throws away your changes to ${f.path}.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Discard', style: 'destructive', onPress: () => void act('Discard', () => client!.call('git.discard', { projectPath, paths: [f.path] })) },
          ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <TabKeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }}>
      <ConnectionBar client={client} state={state} error={error} />
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.branch, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Icon name="git-branch-outline" color={c.accent} />
          <View style={{ flex: 1 }}>
            <T weight="600">{status.branch ?? 'detached HEAD'}</T>
            <T size="sm" tone="dim">
              {status.ahead || status.behind ? `${status.ahead} to push · ${status.behind} to pull` : 'Up to date with remote'}
            </T>
          </View>
          <Button
            small
            kind="ghost"
            title="History"
            icon="time-outline"
            onPress={() => router.push({ pathname: '/host/[hostId]/history', params: { hostId, project: projectPath } })}
          />
          <Button small kind="secondary" title="Pull" icon="arrow-down" loading={busy === 'Pull'} onPress={() => act('Pull', () => client!.call('git.pull', { projectPath }, 150_000))} />
          <Button small kind={status.ahead ? 'primary' : 'secondary'} title="Push" icon="arrow-up" loading={busy === 'Push'} onPress={() => act('Push', () => client!.call('git.push', { projectPath }, 150_000), 'Pushed')} />
        </View>

        {status.files.length === 0 ? (
          <EmptyState icon="checkmark-done-outline" title="No changes" body="Everything is committed." />
        ) : (
          <>
            <FileGroup
              title={`Staged (${staged.length})`}
              files={staged}
              letter={(f) => f.index}
              onPress={(f) => openDiff(f, true)}
              onLong={(f) => fileMenu(f, true)}
              action={staged.length ? { label: 'Unstage all', onPress: () => act('Unstage', () => client!.call('git.unstage', { projectPath, paths: staged.map((f) => f.path) })) } : undefined}
            />
            <FileGroup
              title={`Changes (${unstaged.length})`}
              files={unstaged}
              letter={(f) => (f.index === '?' ? '?' : f.workingDir)}
              onPress={(f) => openDiff(f, false)}
              onLong={(f) => fileMenu(f, false)}
              action={unstaged.length ? { label: 'Stage all', onPress: () => act('Stage', () => client!.call('git.stage', { projectPath, paths: unstaged.map((f) => f.path) })) } : undefined}
            />
            <T size="xs" tone="faint" style={{ textAlign: 'center' }}>
              Tap a file to see its diff · long-press for stage / discard
            </T>
          </>
        )}
      </ScrollView>

      {status.files.length ? (
        <View style={[styles.commit, { borderTopColor: c.border, backgroundColor: c.bg }]}>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder={staged.length ? 'Commit message' : 'Stage files to commit'}
            placeholderTextColor={c.textFaint}
            multiline
            style={[styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.text }]}
          />
          <Button
            title={staged.length ? `Commit ${staged.length} file${staged.length > 1 ? 's' : ''}` : 'Commit'}
            icon="checkmark"
            loading={busy === 'Commit'}
            disabled={!staged.length || !message.trim()}
            onPress={() =>
              act('Commit', async () => {
                await client!.call('git.commit', { projectPath, message: message.trim() });
                setMessage('');
              })
            }
          />
        </View>
      ) : null}
    </TabKeyboardAvoidingView>
  );
}

function FileGroup({
  title,
  files,
  letter,
  onPress,
  onLong,
  action,
}: {
  title: string;
  files: GitFileStatus[];
  letter: (f: GitFileStatus) => string;
  onPress: (f: GitFileStatus) => void;
  onLong: (f: GitFileStatus) => void;
  action?: { label: string; onPress: () => void };
}) {
  const c = useColors();
  if (!files.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <T size="sm" weight="600" tone="dim" style={{ flex: 1 }}>
          {title}
        </T>
        {action ? <Button small kind="ghost" title={action.label} onPress={action.onPress} /> : null}
      </View>
      <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.border }]}>
        {files.map((f, i) => {
          const l = LABEL[letter(f)] ?? { text: letter(f), tone: 'default' as const };
          const name = f.path.split('/').pop();
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
          return (
            <Pressable
              key={f.path}
              onPress={() => onPress(f)}
              onLongPress={() => onLong(f)}
              style={({ pressed }) => [styles.file, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }, pressed && { backgroundColor: c.surfacePressed }]}
            >
              <View style={{ flex: 1 }}>
                <T weight="500" numberOfLines={1}>
                  {name}
                </T>
                {dir ? (
                  <T size="xs" tone="dim" numberOfLines={1}>
                    {dir}
                  </T>
                ) : null}
              </View>
              <Badge text={l.text} tone={l.tone} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  branch: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  group: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  file: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, minHeight: 52, paddingVertical: space.sm },
  commit: { borderTopWidth: StyleSheet.hairlineWidth, padding: space.md, gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, maxHeight: 110, minHeight: 44, fontSize: font.size.md },
});
