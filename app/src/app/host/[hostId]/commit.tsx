import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { GitBackup, GitCommitDetail, RestorePreview, RestoreResult } from '@protocol';
import { Banner, Button, Divider, EmptyState, Icon, Loading, Row, Section, T } from '@/components/ui';
import type { NicodeClient } from '@/lib/client';
import { confirmAction } from '@/lib/confirm';
import { useConnection, useOnConnected } from '@/lib/connections';
import { KeyLockedError } from '@/lib/deviceKey';
import { errorMessage, relativeTime } from '@/lib/util';
import { font, radius, space, useColors } from '@/theme';

type Mode = 'commit' | 'reset';

/**
 * One commit: message, files (tap for the diff), and "Restore the code to this commit"
 * (or, advanced, "Reset the branch here"). With `backups=1`: the list of restore points.
 */
export default function CommitScreen() {
  const { hostId, project, hash, backups } = useLocalSearchParams<{ hostId: string; project: string; hash?: string; backups?: string }>();
  const { client } = useConnection(hostId);
  if (backups === '1') return <RestorePoints project={project} client={client} />;
  return <CommitDetail hostId={hostId} project={project} hash={hash!} client={client} />;
}

function CommitDetail({ hostId, project, hash, client }: { hostId: string; project: string; hash: string; client: NicodeClient | null }) {
  const c = useColors();
  const [commit, setCommit] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Mode | null>(null);

  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('git.show', { projectPath: project, hash })
        .then(setCommit)
        .catch((e) => setError(errorMessage(e)));
    }, [client, project, hash]),
  );

  if (error) return <EmptyState icon="alert-circle-outline" title="Couldn't load this commit" body={error} />;
  if (!commit) return <Loading />;
  const add = commit.files.reduce((a, f) => a + f.add, 0);
  const del = commit.files.reduce((a, f) => a + f.del, 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: commit.hash.slice(0, 7) }} />
      <View style={{ gap: space.xs }}>
        <T size="lg" weight="700">
          {commit.message}
        </T>
        {commit.body ? (
          <T size="sm" tone="dim" selectable>
            {commit.body}
          </T>
        ) : null}
        <T size="sm" tone="dim">
          {commit.author} · {new Date(commit.date).toLocaleString()} ({relativeTime(commit.date)})
        </T>
      </View>

      <Section title={`${commit.files.length} file${commit.files.length === 1 ? '' : 's'} · +${add} −${del}`}>
        {commit.files.length === 0 ? <Row title="No file changes" chevron={false} /> : null}
        {commit.files.slice(0, 200).map((f, i) => (
          <View key={f.path}>
            {i > 0 ? <Divider /> : null}
            <Row
              icon={f.status === 'A' ? 'add-circle-outline' : f.status === 'D' ? 'remove-circle-outline' : 'create-outline'}
              title={f.path}
              subtitle={f.binary ? 'binary' : `+${f.add} −${f.del}`}
              onPress={() => router.push({ pathname: '/host/[hostId]/diff', params: { hostId, project, path: f.path, commit: commit.hash } })}
            />
          </View>
        ))}
      </Section>

      <Section title="Go back to this version" footer="A restore point is saved first, so you can always undo.">
        <Row icon="arrow-undo-outline" title="Restore the code to this commit" subtitle="Makes a new commit with this version's files. History is kept." onPress={() => setRestoring('commit')} />
        <Divider />
        <Row icon="warning-outline" title="Reset the branch here (advanced)" subtitle="Moves the branch back and drops the newer commits." danger onPress={() => setRestoring('reset')} />
        <Divider />
        <Row icon="copy-outline" title="Copy commit hash" subtitle={commit.hash} chevron={false} onPress={() => void Clipboard.setStringAsync(commit.hash)} />
      </Section>

      {restoring && client ? <RestoreSheet client={client} project={project} hash={commit.hash} mode={restoring} onClose={() => setRestoring(null)} /> : null}
    </ScrollView>
  );
}

/** Gate 1: what will happen. Gate 2: confirm (reset: type the short hash). Gate 3: fingerprint. */
function RestoreSheet({ client, project, hash, mode, onClose }: { client: NicodeClient; project: string; hash: string; mode: Mode; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const short = hash.slice(0, 7);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [undone, setUndone] = useState(false);
  const [pushed, setPushed] = useState(false);

  useOnConnected(
    client,
    useCallback(() => {
      client
        .call('git.restorePreview', { projectPath: project, hash })
        .then(setPreview)
        .catch((e) => setError(errorMessage(e)));
    }, [client, project, hash]),
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      if (!(err instanceof KeyLockedError)) setError(errorMessage(err));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  const restore = () =>
    Alert.alert(
      mode === 'commit' ? `Restore the code to ${short}?` : `Reset the branch to ${short}?`,
      mode === 'commit'
        ? 'A new commit will contain this version of the files. Nothing is deleted from history.'
        : `${preview?.commitsAfter ?? 'The'} newer commit(s) will be removed from the branch. A restore point is saved first.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: mode === 'commit' ? 'Restore' : 'Reset',
          style: 'destructive',
          onPress: () =>
            void run(async () => {
              const proof = await confirmAction(client, 'git.restoreTo', [project, hash, mode], `Confirm: ${mode === 'commit' ? 'restore' : 'reset'} to ${short}`);
              setResult(await client.call('git.restoreTo', { projectPath: project, hash, mode, proof }, 180_000));
            }),
        },
      ],
    );

  const undo = () =>
    void run(async () => {
      const proof = await confirmAction(client, 'git.undoRestore', [project, result!.backupRef], 'Confirm: undo the restore');
      await client.call('git.undoRestore', { projectPath: project, backupRef: result!.backupRef, proof }, 180_000);
      setUndone(true);
    });

  const push = () =>
    void run(async () => {
      await client.call('git.push', { projectPath: project }, 150_000);
      setPushed(true);
    });

  const blocked = !preview || preview.busy || (mode === 'reset' && (!preview.isAncestor || typed.trim().toLowerCase() !== short));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: c.overlay }]} onPress={busy ? undefined : onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + space.lg }]} onPress={() => undefined}>
          <ScrollView contentContainerStyle={{ gap: space.md }} keyboardShouldPersistTaps="handled">
            <T size="lg" weight="700">
              {mode === 'commit' ? 'Restore the code' : 'Reset the branch'} to {short}
            </T>

            {result ? (
              undone ? (
                <>
                  <Banner tone="success" icon="arrow-undo" title="Undone" body="The project is back to how it was before the restore, including uncommitted changes." />
                  <Button title="Done" onPress={onClose} />
                </>
              ) : (
                <>
                  <Banner
                    tone="success"
                    icon="checkmark-circle"
                    title={mode === 'commit' ? 'Code restored' : `Branch reset (${result.removedCommits} commit${result.removedCommits === 1 ? '' : 's'} removed)`}
                    body={mode === 'commit' ? 'A new commit holds the old version. Push it to share it.' : 'The newer commits are kept in a restore point.'}
                  />
                  {result.needsForcePush ? (
                    <Banner tone="warning" icon="warning-outline" title="The removed commits were already pushed" body="niCode never force-pushes. Run a force push yourself in the terminal if you really want to rewrite the remote." />
                  ) : null}
                  {mode === 'commit' ? <Button title={pushed ? 'Pushed' : 'Push'} icon="cloud-upload-outline" kind="secondary" disabled={pushed} loading={busy} onPress={push} /> : null}
                  <Button title="Undo this restore" icon="arrow-undo-outline" kind="secondary" loading={busy} onPress={undo} />
                  <Button title="Done" onPress={onClose} />
                </>
              )
            ) : !preview ? (
              error ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't check this commit" body={error} /> : <Loading />
            ) : (
              <>
                <T tone="dim">“{preview.subject}”</T>
                <View style={[styles.facts, { backgroundColor: c.bg }]}>
                  <Fact icon="git-commit-outline" text={preview.commitsAfter ? `${preview.commitsAfter} newer commit${preview.commitsAfter === 1 ? '' : 's'} ${mode === 'commit' ? 'will be undone in the files (history kept)' : 'will be removed from the branch'}` : 'This is the latest commit'} />
                  <Fact icon="document-text-outline" text={`${preview.totalFiles} file${preview.totalFiles === 1 ? '' : 's'} will change or be deleted`} />
                  {preview.dirty ? <Fact icon="save-outline" text="Your uncommitted changes are saved in the restore point first" /> : null}
                  <Fact icon="shield-checkmark-outline" text="A restore point lets you undo this" />
                </View>
                {preview.files.slice(0, 8).map((f) => (
                  <T key={f.path} size="xs" tone="dim" mono numberOfLines={1}>
                    {f.status} {f.path}
                  </T>
                ))}
                {preview.totalFiles > 8 ? (
                  <T size="xs" tone="faint">
                    …and {preview.totalFiles - 8} more
                  </T>
                ) : null}

                {preview.busy ? <Banner tone="warning" icon="hourglass-outline" title="Claude is working in this project" body="Stop it first, then restore." /> : null}
                {mode === 'reset' && !preview.isAncestor ? <Banner tone="danger" icon="alert-circle-outline" title="Not on this branch" body="Only commits on the current branch can be reset to. Use “Restore the code” instead." /> : null}
                {mode === 'reset' && preview.pushedAfter ? (
                  <Banner tone="danger" icon="cloud-outline" title="Newer commits are already pushed" body="Resetting rewrites history: the remote would need a force push, which niCode won't do for you." />
                ) : null}
                {mode === 'reset' && preview.isAncestor ? (
                  <View style={{ gap: space.xs }}>
                    <T size="sm" weight="600">
                      Type <T size="sm" mono weight="700">{short}</T> to confirm
                    </T>
                    <TextInput
                      value={typed}
                      onChangeText={setTyped}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder={short}
                      placeholderTextColor={c.textFaint}
                      style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.bg }]}
                    />
                  </View>
                ) : null}
                {error ? <Banner tone="danger" icon="alert-circle-outline" title="That didn't work" body={error} /> : null}
                <Button
                  title={mode === 'commit' ? 'Restore with fingerprint' : 'Reset with fingerprint'}
                  icon="finger-print"
                  kind={mode === 'commit' ? 'primary' : 'danger'}
                  disabled={blocked}
                  loading={busy}
                  onPress={restore}
                />
                <Button title="Cancel" kind="ghost" disabled={busy} onPress={onClose} />
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Fact({ icon, text }: { icon: 'git-commit-outline' | 'document-text-outline' | 'save-outline' | 'shield-checkmark-outline'; text: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
      <Icon name={icon} size={16} color={c.accent} />
      <T size="sm" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

/** Restore points saved before each restore; undoing one needs a fingerprint too. */
function RestorePoints({ project, client }: { project: string; client: NicodeClient | null }) {
  const c = useColors();
  const [list, setList] = useState<GitBackup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      ?.call('git.backups', { projectPath: project })
      .then(setList)
      .catch((e) => setError(errorMessage(e)));
  }, [client, project]);
  useOnConnected(client, load);

  const undo = (b: GitBackup) =>
    Alert.alert('Go back to this restore point?', `The project returns to “${b.subject}”${b.hadUncommitted ? ' with the uncommitted changes you had then' : ''}. Changes made since are replaced.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Go back',
        style: 'destructive',
        onPress: async () => {
          if (!client) return;
          setBusy(b.ref);
          setError(null);
          try {
            const proof = await confirmAction(client, 'git.undoRestore', [project, b.ref], 'Confirm: go back to a restore point');
            await client.call('git.undoRestore', { projectPath: project, backupRef: b.ref, proof }, 180_000);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            router.back();
          } catch (err) {
            if (!(err instanceof KeyLockedError)) setError(errorMessage(err));
          } finally {
            setBusy(null);
          }
        },
      },
    ]);

  if (!list) return error ? <EmptyState icon="alert-circle-outline" title="Couldn't load restore points" body={error} /> : <Loading />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Stack.Screen options={{ title: 'Restore points' }} />
      <T tone="dim">Saved automatically before each restore and kept for 30 days.</T>
      {error ? <Banner tone="danger" icon="alert-circle-outline" title="That didn't work" body={error} /> : null}
      <Section>
        {list.length === 0 ? <Row title="No restore points" chevron={false} /> : null}
        {list.map((b, i) => (
          <View key={b.ref}>
            {i > 0 ? <Divider /> : null}
            <Row
              icon="shield-checkmark-outline"
              title={b.subject}
              subtitle={`${relativeTime(b.createdAt)} · ${b.head.slice(0, 7)}${b.hadUncommitted ? ' · with uncommitted changes' : ''}`}
              right={busy === b.ref ? <Loading /> : undefined}
              onPress={busy ? undefined : () => undo(b)}
            />
          </View>
        ))}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, maxHeight: '88%' },
  facts: { borderRadius: radius.md, padding: space.md, gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, fontFamily: font.mono, fontSize: font.size.md },
});
