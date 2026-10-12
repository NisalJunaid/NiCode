import * as Haptics from 'expo-haptics';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import type { AppProcess } from '@protocol';
import { OutputBox, StepList, useTaskStream } from '@/components/TaskConsole';
import { Banner, Badge, Button, EmptyState, IconButton, Loading, Row, Section, Divider, T } from '@/components/ui';
import { appTone, uptime } from '@/lib/apps';
import { useConnection } from '@/lib/connections';
import { basename, errorMessage, pathKey, randomId } from '@/lib/util';
import { space, useColors } from '@/theme';

/** One app: health, restart/stop/start, one-tap deploy, live logs, add a domain. */
export default function AppDetail() {
  const c = useColors();
  const { hostId, name } = useLocalSearchParams<{ hostId: string; name: string }>();
  const { client, state } = useConnection(hostId);
  const [app, setApp] = useState<AppProcess | null | undefined>(undefined);
  const [logs, setLogs] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [deployOp, setDeployOp] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<'ok' | 'failed' | null>(null);
  const deploy = useTaskStream(client, deployOp);

  const load = useCallback(async () => {
    if (!client || client.state !== 'open') return;
    const list = await client.call('apps.list', {}).catch(() => null);
    if (list) setApp(list.find((a) => a.name === name) ?? null);
    const l = await client.call('apps.logs', { name, lines: 300 }).catch(() => null);
    if (l) setLogs(l.text);
  }, [client, name]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(() => void load(), 3000); // live-ish logs & status
      return () => clearInterval(t);
    }, [load]),
  );

  if (app === undefined) return state === 'open' ? <Loading /> : null;
  if (app === null) return <EmptyState icon="alert-circle-outline" title="App not found" body={`${name} is no longer in pm2.`} />;

  const tone = appTone(app);
  const act = async (action: 'start' | 'stop' | 'restart' | 'delete') => {
    setBusy(action);
    try {
      await client!.call('apps.action', { name, action }, 90_000);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (action === 'delete') return router.back();
      await load();
    } catch (err) {
      Alert.alert(`Couldn't ${action}`, errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const runDeploy = async () => {
    const id = randomId();
    setDeployOp(id);
    setDeployResult(null);
    setBusy('deploy');
    try {
      await client!.call('apps.deploy', { name, opId: id }, 40 * 60_000);
      setDeployResult('ok');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load();
    } catch {
      setDeployResult('failed');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: name, headerRight: () => <IconButton icon="refresh" label="Refresh" onPress={load} /> }} />

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Badge text={tone.label} tone={tone.dot === 'ok' ? 'success' : tone.dot === 'bad' ? 'danger' : tone.dot === 'busy' ? 'warning' : 'default'} />
        {app.status === 'online' ? <Badge text={`up ${uptime(app.uptimeSince)}`} /> : null}
        <Badge text={`${app.memoryMb} MB · ${app.cpu}% CPU`} />
        {app.restarts ? <Badge text={`${app.restarts} restarts`} tone={app.restarts > 5 ? 'warning' : 'default'} /> : null}
      </View>
      {app.status === 'errored' ? <Banner tone="danger" icon="warning-outline" title="This app keeps crashing" body="Check the logs below, or ask Claude to look at them." /> : null}

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button title="Restart" icon="refresh" kind="secondary" loading={busy === 'restart'} onPress={() => void act('restart')} style={{ flex: 1 }} />
        {app.status === 'online' ? (
          <Button title="Stop" icon="stop" kind="secondary" loading={busy === 'stop'} onPress={() => void act('stop')} style={{ flex: 1 }} />
        ) : (
          <Button title="Start" icon="play" loading={busy === 'start'} onPress={() => void act('start')} style={{ flex: 1 }} />
        )}
      </View>

      {app.projectPath ? (
        <Section title="Deploy" footer="Pulls the latest code, installs dependencies, builds, then reloads with no downtime.">
          <Row icon="rocket-outline" title="Deploy latest version" subtitle="git pull → install → build → reload" onPress={busy ? undefined : () => void runDeploy()} />
        </Section>
      ) : null}
      {deployOp ? (
        <View style={{ gap: space.sm }}>
          <StepList steps={deploy.steps} />
          {deployResult === 'failed' ? <OutputBox text={deploy.output} height={200} /> : null}
          {deployResult === 'ok' ? <Banner tone="success" icon="checkmark-circle" title="Deployed" /> : null}
        </View>
      ) : null}

      <Section title="Details">
        <Row icon="terminal-outline" title="Runs" subtitle={app.command} mono chevron={false} />
        <Divider />
        <Row icon="folder-outline" title="Folder" subtitle={app.cwd} chevron={false} />
        {app.projectPath ? (
          <>
            <Divider />
            <Row
              icon="git-branch-outline"
              title="Project"
              subtitle={basename(app.projectPath)}
              onPress={() => router.push({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(app.projectPath!) } })}
            />
          </>
        ) : null}
        {app.port ? (
          <>
            <Divider />
            <Row
              icon="globe-outline"
              title="Add a domain"
              subtitle={`Point a domain at port ${app.port} with HTTPS`}
              onPress={() =>
                router.push({ pathname: '/host/[hostId]/add-domain', params: { hostId, kind: 'proxy', port: String(app.port), ...(app.projectPath ? { project: app.projectPath } : {}) } })
              }
            />
          </>
        ) : null}
      </Section>

      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T size="sm" weight="700" tone="dim" style={{ flex: 1, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Logs
          </T>
          <T size="xs" tone="faint">updates every 3 s</T>
        </View>
        <OutputBox text={logs} placeholder="No log output yet." height={360} />
      </View>

      <Section>
        <Row
          icon="trash-outline"
          title="Remove from pm2"
          danger
          chevron={false}
          onPress={() =>
            Alert.alert(`Remove ${name}?`, 'Stops it and removes it from pm2. Project files are kept.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: () => void act('delete') },
            ])
          }
        />
      </Section>
    </ScrollView>
  );
}
