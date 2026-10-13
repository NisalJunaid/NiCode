import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TurnFileChange, TurnSummary } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { errorMessage } from '@/lib/util';
import { font, radius, space, useColors } from '@/theme';
import { Banner, Button, Icon, T } from '../ui';

const STATUS: Record<TurnFileChange['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'accent' }> = {
  A: { label: 'new', tone: 'success' },
  M: { label: 'edited', tone: 'warning' },
  D: { label: 'deleted', tone: 'danger' },
  R: { label: 'renamed', tone: 'accent' },
};
const SHOWN = 5;

/**
 * "What changed" after a Claude turn: files touched (+/−), the test result, and one-tap
 * Commit & push or Undo (rewinds the files to before the turn).
 */
export function TurnSummaryCard({
  summary,
  prompt,
  hostId,
  projectPath,
  client,
  disabled,
  onUndo,
}: {
  summary: TurnSummary;
  prompt: string;
  hostId: string;
  projectPath: string;
  client: NicodeClient | null;
  disabled: boolean;
  onUndo: () => void;
}) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const [committing, setCommitting] = useState(false);
  const files = all ? summary.files : summary.files.slice(0, SHOWN);

  if (summary.totalFiles === 0) {
    return (
      <View style={styles.none}>
        <Icon name="document-outline" size={14} color={c.textFaint} />
        <T size="xs" tone="faint">
          No files changed{summary.tests ? ` · tests ${summary.tests.passed ? 'passed' : 'failed'}` : ''}
        </T>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Icon name="git-compare-outline" size={16} color={c.accent} />
        <T weight="700" style={{ flex: 1 }}>
          {summary.totalFiles} file{summary.totalFiles > 1 ? 's' : ''} changed
        </T>
        <T size="sm" tone="success" mono>
          +{summary.add}
        </T>
        <T size="sm" tone="danger" mono>
          −{summary.del}
        </T>
      </View>
      {summary.tests ? (
        <View style={[styles.tests, { backgroundColor: summary.tests.passed ? c.successSoft : c.dangerSoft }]}>
          <Icon name={summary.tests.passed ? 'checkmark-circle' : 'close-circle'} size={14} color={summary.tests.passed ? c.success : c.danger} />
          <T size="xs" weight="600" style={{ color: summary.tests.passed ? c.success : c.danger }}>
            Tests {summary.tests.passed ? 'passed' : 'failed'}
          </T>
          <T size="xs" tone="dim" mono numberOfLines={1} style={{ flex: 1 }}>
            {summary.tests.command}
          </T>
        </View>
      ) : null}
      <View>
        {files.map((f) => (
          <Pressable
            key={f.path}
            accessibilityRole="button"
            accessibilityLabel={`${f.path}, ${STATUS[f.status].label}`}
            onPress={() => router.push({ pathname: '/host/[hostId]/diff', params: { hostId, project: projectPath, path: f.path, base: summary.from, head: summary.to } })}
            style={({ pressed }) => [styles.file, pressed && { backgroundColor: c.surfacePressed }]}
          >
            <T size="xs" weight="700" tone={STATUS[f.status].tone} style={{ width: 14 }}>
              {f.status}
            </T>
            <T size="sm" mono numberOfLines={1} style={{ flex: 1 }}>
              {f.path}
            </T>
            {f.binary ? (
              <T size="xs" tone="faint">
                binary
              </T>
            ) : (
              <T size="xs" tone="dim" mono>
                +{f.add} −{f.del}
              </T>
            )}
          </Pressable>
        ))}
        {summary.files.length > SHOWN ? (
          <Pressable onPress={() => setAll((v) => !v)} style={styles.file}>
            <T size="xs" tone="accent" weight="600">
              {all ? 'Show less' : `Show all ${summary.totalFiles}`}
            </T>
          </Pressable>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button small title="Commit & push" icon="cloud-upload-outline" disabled={disabled} onPress={() => setCommitting(true)} style={{ flex: 1 }} />
        <Button
          small
          kind="secondary"
          title="Undo"
          icon="arrow-undo-outline"
          disabled={disabled}
          onPress={() =>
            Alert.alert('Undo this turn?', `The ${summary.totalFiles} changed file${summary.totalFiles > 1 ? 's go' : ' goes'} back to how they were before. You can redo it afterwards.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Undo', style: 'destructive', onPress: onUndo },
            ])
          }
        />
      </View>
      {committing ? <CommitSheet summary={summary} prompt={prompt} projectPath={projectPath} client={client} onClose={() => setCommitting(false)} /> : null}
    </View>
  );
}

function CommitSheet({ summary, prompt, projectPath, client, onClose }: { summary: TurnSummary; prompt: string; projectPath: string; client: NicodeClient | null; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const firstLine = prompt.split('\n')[0]!.trim();
  const [message, setMessage] = useState(firstLine.length > 72 ? firstLine.slice(0, 69) + '…' : firstLine);
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      // Only this turn's files (deleted ones too: `git add` stages removals).
      await client.call('git.stage', { projectPath, paths: summary.files.map((f) => f.path) });
      const { hash } = await client.call('git.commit', { projectPath, message: message.trim() });
      let note = `Committed ${hash.slice(0, 7)}`;
      if (push) {
        await client.call('git.push', { projectPath }, 120_000);
        note += ' and pushed';
      }
      setDone(note);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(errorMessage(err));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: c.overlay }]} onPress={busy ? undefined : onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + space.lg }]} onPress={() => undefined}>
          <T size="lg" weight="700">
            Commit this turn
          </T>
          {done ? (
            <>
              <Banner tone="success" icon="checkmark-circle" title={done} />
              <Button title="Done" onPress={onClose} />
            </>
          ) : (
            <>
              <T size="sm" tone="dim">
                {summary.totalFiles} file{summary.totalFiles > 1 ? 's' : ''} from this turn. Other uncommitted changes stay as they are.
              </T>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="Commit message"
                placeholderTextColor={c.textFaint}
                multiline
                style={[styles.msg, { color: c.text, borderColor: c.border, backgroundColor: c.bg }]}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T style={{ flex: 1 }}>Push after committing</T>
                <Switch value={push} onValueChange={setPush} trackColor={{ true: c.accent, false: c.surface2 }} thumbColor="#fff" />
              </View>
              {error ? <Banner tone="danger" icon="alert-circle-outline" title="That didn't work" body={error} /> : null}
              <Button title={push ? 'Commit & push' : 'Commit'} icon="checkmark" loading={busy} disabled={!message.trim()} onPress={() => void commit()} />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  none: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.xs },
  tests: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4 },
  file: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 6 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, gap: space.md },
  msg: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, minHeight: 64, fontSize: font.size.md },
});
