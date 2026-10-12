import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import type { AppProcess, AppsStatus } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { appTone, uptime } from '@/lib/apps';
import { basename, errorMessage, randomId } from '@/lib/util';
import { radius, space, useColors } from '@/theme';
import { StepList, useTaskStream } from './TaskConsole';
import { Banner, Button, StatusDot, T } from './ui';

/** One pm2 app: status at a glance + the two actions you need most (restart, stop/start). */
export function AppCard({ hostId, client, app, onChanged, showProject }: { hostId: string; client: NicodeClient; app: AppProcess; onChanged: () => void; showProject?: boolean }) {
  const c = useColors();
  const [busy, setBusy] = useState<string | null>(null);
  const tone = appTone(app);
  const online = app.status === 'online';

  const act = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action);
    try {
      await client.call('apps.action', { name: app.name, action }, 90_000);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onChanged();
    } catch (err) {
      Alert.alert(`Couldn't ${action} ${app.name}`, errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${app.name}, ${tone.label}`}
      onPress={() => router.push({ pathname: '/host/[hostId]/app', params: { hostId, name: app.name } })}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: app.status === 'errored' ? c.danger : c.border }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <StatusDot tone={tone.dot} />
        <T weight="700" style={{ flex: 1 }} numberOfLines={1}>
          {app.name}
        </T>
        {online ? (
          <T size="xs" tone="dim">
            up {uptime(app.uptimeSince)} · {app.memoryMb} MB
          </T>
        ) : null}
      </View>
      <T size="sm" tone="dim" numberOfLines={1}>
        {tone.label}
        {showProject && app.projectPath ? ` · ${basename(app.projectPath)}` : ''}
        {app.restarts > 0 ? ` · ${app.restarts} restart${app.restarts > 1 ? 's' : ''}` : ''}
      </T>
      <T size="xs" tone="faint" mono numberOfLines={1}>
        {app.command}
      </T>
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: 2 }}>
        <Button small kind="secondary" title="Restart" icon="refresh" loading={busy === 'restart'} onPress={() => void act('restart')} style={{ flex: 1 }} />
        {online ? (
          <Button
            small
            kind="secondary"
            title="Stop"
            icon="stop"
            loading={busy === 'stop'}
            onPress={() =>
              Alert.alert(`Stop ${app.name}?`, 'It stays stopped until you start it again (also after a reboot).', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Stop', style: 'destructive', onPress: () => void act('stop') },
              ])
            }
            style={{ flex: 1 }}
          />
        ) : (
          <Button small title="Start" icon="play" loading={busy === 'start'} onPress={() => void act('start')} style={{ flex: 1 }} />
        )}
        <Button small kind="ghost" title="Logs" icon="document-text-outline" onPress={() => router.push({ pathname: '/host/[hostId]/app', params: { hostId, name: app.name } })} />
      </View>
    </Pressable>
  );
}

/** Shown when pm2 is missing or not set to start on boot; one tap fixes it. */
export function Pm2Setup({ client, status, onDone }: { client: NicodeClient; status: AppsStatus; onDone: (s: AppsStatus) => void }) {
  const [opId, setOpId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { steps } = useTaskStream(client, opId);
  if (status.pm2 && status.startupEnabled && !opId) return null;
  const setup = async () => {
    const id = randomId();
    setOpId(id);
    setBusy(true);
    setError(null);
    try {
      onDone(await client.call('apps.setup', { opId: id }, 660_000));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: space.sm }}>
      {!opId ? (
        <Banner
          tone={status.pm2 ? 'warning' : 'accent'}
          icon={status.pm2 ? 'power-outline' : 'rocket-outline'}
          title={status.pm2 ? 'Apps won\'t come back after a reboot' : 'Keep apps running with pm2'}
          body={
            status.pm2
              ? 'Turn on "start on boot" so pm2 restores your apps when the server restarts.'
              : 'pm2 keeps your apps running, restarts them if they crash and brings them back after a reboot.'
          }
          action={<Button small title={status.pm2 ? 'Turn on' : 'Set up pm2'} loading={busy} onPress={setup} />}
        />
      ) : (
        <StepList steps={steps} />
      )}
      {error ? <Banner tone="danger" icon="alert-circle-outline" title="Setup failed" body={error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: 4 },
});
