import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import type { AnalyzeDb, AnalyzeDbSuggestion } from '@protocol';
import { Badge, Banner, Button, Card, Field, Loading, Screen, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage, relativeTime } from '@/lib/util';
import { space, useColors } from '@/theme';

/**
 * Read-only database access for Analyze chats in one project: niCode suggests the SQL for a
 * SELECT-only user (from the project's .env), you run it as the DB admin, then niCode tests the
 * user, checks it really can't write, and keeps it on the server. The password never comes back.
 */
export default function AnalyzeDbScreen() {
  const c = useColors();
  const { hostId, project } = useLocalSearchParams<{ hostId: string; project: string }>();
  const { client, info } = useConnection(hostId);
  const [db, setDb] = useState<AnalyzeDb | null | undefined>(undefined);
  const [suggestion, setSuggestion] = useState<AnalyzeDbSuggestion | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    client
      ?.call('analyze.db.get', { projectPath: project })
      .then(setDb)
      .catch(() => setDb(null));
  }, [client, project]);
  useOnConnected(client, load);

  const suggest = async () => {
    if (!client) return;
    setBusy('suggest');
    setError(null);
    try {
      const s = await client.call('analyze.db.suggest', { projectPath: project });
      setSuggestion(s);
      if (s.url) setUrl(s.url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!client || !url.trim()) return;
    setBusy('save');
    setError(null);
    try {
      setDb(await client.call('analyze.db.set', { projectPath: project, url: url.trim() }, 60_000));
      setSuggestion(null);
      setUrl('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const clear = () =>
    Alert.alert('Remove the read-only database?', 'Analyze chats in this project will no longer get database access. The DB user itself stays.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void client
            ?.call('analyze.db.clear', { projectPath: project })
            .then(() => setDb(null))
            .catch((err) => setError(errorMessage(err))),
      },
    ]);

  return (
    <Screen scroll>
      <View style={{ gap: space.xs }}>
        <T size="lg" weight="700">
          {basename(project)}
        </T>
        <T tone="dim">
          Analyze chats are read-only{info?.analyzeIsolation === 'kernel' ? ' (Claude runs in a sandbox where the whole server is read-only)' : ''}. To look at data, give
          them a database user that can only read.
        </T>
      </View>

      {db === undefined ? (
        <Loading />
      ) : db ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <T weight="600" style={{ flex: 1 }}>
              {db.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} · {db.database}
            </T>
            <Badge text="Read-only" tone="success" />
          </View>
          <T size="sm" tone="dim" mono>
            {db.user}@{db.host}:{db.port}
          </T>
          <T size="xs" tone="faint">
            Verified {relativeTime(db.verifiedAt)}. Analyze chats get it as $NICODE_READONLY_DB_URL.
          </T>
          <Button small kind="ghost" title="Remove" icon="trash-outline" onPress={clear} />
        </Card>
      ) : (
        <Banner tone="warning" icon="server-outline" title="No read-only database yet" body="Analyze chats can read code and logs, but won't query the database." />
      )}

      <Card>
        <T weight="600">{db ? 'Replace it' : 'Set it up'}</T>
        <T size="sm" tone="dim">
          1. Get the SQL for a SELECT-only user (from this project&apos;s .env).
        </T>
        <Button small kind="secondary" title="Suggest the SQL" icon="sparkles-outline" loading={busy === 'suggest'} onPress={suggest} />
        {suggestion ? (
          suggestion.kind ? (
            <>
              <View style={{ backgroundColor: c.codeBg, borderRadius: 10, padding: space.md }}>
                <T mono size="xs" selectable>
                  {suggestion.sql}
                </T>
              </View>
              <Button small kind="ghost" title="Copy SQL" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(suggestion.sql)} />
              <T size="sm" tone="dim">
                2. Run it as the database admin: in the Terminal tab ({suggestion.kind === 'postgres' ? 'sudo -u postgres psql' : 'sudo mysql'}) or your DB tool.
              </T>
            </>
          ) : (
            <T size="sm" tone="warning">
              {suggestion.reason}
            </T>
          )
        ) : null}
        <T size="sm" tone="dim">
          {suggestion?.kind ? '3.' : '2.'} Test and save. niCode checks that this user can&apos;t write before saving it.
        </T>
        <Field
          placeholder="postgres://user:password@127.0.0.1:5432/db"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={!suggestion?.url || url !== suggestion.url}
        />
        <Button title="Test & save" icon="checkmark" loading={busy === 'save'} disabled={!url.trim()} onPress={save} />
        {error ? (
          <T size="sm" tone="danger">
            {error}
          </T>
        ) : null}
      </Card>
    </Screen>
  );
}
