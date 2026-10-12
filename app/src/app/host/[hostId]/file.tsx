import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { CodeView } from '@/components/CodeView';
import { Banner, Button, EmptyState, IconButton, Loading, T } from '@/components/ui';
import { RpcCallError } from '@/lib/client';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage } from '@/lib/util';
import { font, space, useColors } from '@/theme';

interface FileData {
  content: string;
  encoding: 'utf8' | 'base64';
  mtimeMs: number;
  size: number;
  truncated: boolean;
}

/** View a file (highlighted); "Edit" switches to a plain editor with conflict-safe saving. */
export default function FileScreen() {
  const c = useColors();
  const { hostId, project, path, line } = useLocalSearchParams<{ hostId: string; project: string; path: string; line?: string }>();
  const { client } = useConnection(hostId);
  const [file, setFile] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [wrap, setWrap] = useState(true);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setFile(await client.call('fs.read', { projectPath: project, path }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client, project, path]);
  useOnConnected(client, load);

  const save = async (force = false) => {
    if (!client || !file) return;
    setSaving(true);
    try {
      const r = await client.call('fs.write', { projectPath: project, path, content: draft, ...(force ? {} : { expectedMtimeMs: file.mtimeMs }) });
      setFile({ ...file, content: draft, mtimeMs: r.mtimeMs });
      setEditing(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === 'conflict') {
        Alert.alert('File changed on the server', 'Someone (maybe Claude) changed this file after you opened it.', [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Load their version', onPress: () => void load().then(() => setEditing(false)) },
          { text: 'Overwrite', style: 'destructive', onPress: () => void save(true) },
        ]);
      } else Alert.alert('Couldn\'t save', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const binary = file?.encoding === 'base64';
  const header = (
    <Stack.Screen
      options={{
        title: basename(path),
        headerRight: () =>
          file && !binary && !file.truncated ? (
            editing ? (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconButton icon="close" label="Cancel editing" onPress={() => setEditing(false)} />
                <Button small title="Save" loading={saving} onPress={() => save()} />
              </View>
            ) : (
              <View style={{ flexDirection: 'row' }}>
                <IconButton icon={wrap ? 'reorder-four-outline' : 'swap-horizontal'} label={wrap ? 'Turn off line wrap' : 'Wrap lines'} onPress={() => setWrap((w) => !w)} />
                <IconButton
                  icon="create-outline"
                  label="Edit file"
                  onPress={() => {
                    setDraft(file.content);
                    setEditing(true);
                  }}
                />
              </View>
            )
          ) : null,
      }}
    />
  );

  if (error) return (<>{header}<EmptyState icon="alert-circle-outline" title="Couldn't open file" body={error} action={<Button small title="Retry" onPress={load} />} /></>);
  if (!file) return (<>{header}<Loading /></>);
  if (binary) return (<>{header}<EmptyState icon="document-outline" title="Binary file" body={`${Math.round(file.size / 1024)} KB · can't be shown as text`} /></>);

  return (
    <View style={{ flex: 1, backgroundColor: c.codeBg }}>
      {header}
      <T size="xs" tone="faint" mono numberOfLines={1} style={{ paddingHorizontal: space.md, paddingVertical: 6, backgroundColor: c.bg }}>
        {path}
      </T>
      {file.truncated ? (
        <View style={{ padding: space.md }}>
          <Banner tone="warning" icon="information-circle-outline" title="Showing the first 1 MB" body="Large files are read-only in the app." />
        </View>
      ) : null}
      {editing ? (
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            selectionColor={c.accent}
            style={{ flex: 1, color: c.text, fontFamily: font.mono, fontSize: 13, padding: space.md }}
          />
        </KeyboardAvoidingView>
      ) : (
        <CodeView code={file.content} path={path} line={line ? Number(line) : undefined} wrap={wrap} />
      )}
    </View>
  );
}
