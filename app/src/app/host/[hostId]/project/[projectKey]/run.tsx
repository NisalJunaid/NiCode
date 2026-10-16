import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { AppProcess, AppsStatus, ProjectTask } from '@protocol';
import { AppCard, Pm2Setup } from '@/components/AppCard';
import { ConnectionBar } from '@/components/ConnectionBar';
import { DeployPanel } from '@/components/DeployPanel';
import { RpcCallError } from '@/lib/client';
import { confirmAction } from '@/lib/confirm';
import { OutputBox, useTaskStream } from '@/components/TaskConsole';
import { Banner, Button, type IconName, Icon, IconButton, Loading, T } from '@/components/ui';
import { useConnection } from '@/lib/connections';
import { useProject } from '@/lib/project';
import { errorMessage, randomId } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

const GROUP: Record<ProjectTask['group'], { title: string; icon: IconName }> = {
  git: { title: 'Code', icon: 'git-pull-request-outline' },
  install: { title: 'Dependencies', icon: 'cube-outline' },
  build: { title: 'Build', icon: 'hammer-outline' },
  migrate: { title: 'Database migrations', icon: 'server-outline' },
  script: { title: 'Scripts', icon: 'flash-outline' },
  php: { title: 'Laravel', icon: 'logo-laravel' },
};

/** Run tab: this project's running apps + one-tap tasks (pull, install, build, scripts) with live output. */
export default function RunTab() {
  const c = useColors();
  const { hostId, projectPath } = useProject();
  const { client, state, error, info } = useConnection(hostId);
  const production = info?.role === 'production';
  const [status, setStatus] = useState<AppsStatus | null>(null);
  const [apps, setApps] = useState<AppProcess[] | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[] | null>(null);
  const [running, setRunning] = useState<{ task: ProjectTask; opId: string; code: number | null; error?: string } | null>(null);
  const stream = useTaskStream(client, running?.opId ?? null);

  const load = useCallback(async () => {
    if (!client || client.state !== 'open') return;
    const [st, list, t] = await Promise.all([
      client.call('apps.status', {}).catch(() => null),
      client.call('apps.list', {}).catch(() => []),
      client.call('tasks.list', { projectPath }).catch(() => []),
    ]);
    setStatus(st);
    setApps(list.filter((a) => a.projectPath === projectPath));
    setTasks(t);
  }, [client, projectPath]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // Keep status/CPU/memory fresh while the tab is open.
      const timer = setInterval(() => void load(), 5000);
      return () => clearInterval(timer);
    }, [load]),
  );
  useEffect(() => {
    if (state === 'open') void load();
  }, [state, load]);

  const runTask = async (task: ProjectTask) => {
    if (!client) return;
    let proof;
    if (task.group === 'migrate' && production) {
      // Migrations change the production database: fresh fingerprint (bound to this task).
      try {
        proof = await confirmAction(client, 'tasks.run', [projectPath, task.id], 'Confirm migrating the production database');
      } catch (err) {
        return Alert.alert('Not confirmed', errorMessage(err));
      }
    }
    const opId = randomId();
    setRunning({ task, opId, code: null });
    try {
      const r = await client.call('tasks.run', { projectPath, taskId: task.id, opId, ...(proof ? { proof } : {}) }, 31 * 60_000);
      setRunning((cur) => (cur?.opId === opId ? { ...cur, code: r.code } : cur));
      void Haptics.notificationAsync(r.code === 0 ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
      void load();
    } catch (err) {
      const dirty = err instanceof RpcCallError && err.code === 'dirty' ? ' Use Deploy → Pull to stash or discard them first.' : '';
      setRunning((cur) => (cur?.opId === opId ? { ...cur, code: -1, error: errorMessage(err) + dirty } : cur));
    }
  };
  const deploy = client ? <DeployPanel client={client} hostId={hostId} projectPath={projectPath} production={production} onDone={() => void load()} /> : null;

  if (!status || !apps || !tasks) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ConnectionBar client={client} state={state} error={error} />
        {state === 'open' ? <Loading /> : null}
      </View>
    );
  }

  const groups = (Object.keys(GROUP) as ProjectTask['group'][]).map((g) => ({ g, items: tasks.filter((t) => t.group === g) })).filter((x) => x.items.length);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
    >
      <ConnectionBar client={client} state={state} error={error} />
      {client ? <Pm2Setup client={client} status={status} onDone={(s) => { setStatus(s); void load(); }} /> : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button title="Live preview" icon="eye-outline" kind="secondary" onPress={() => router.push({ pathname: '/host/[hostId]/preview', params: { hostId, project: projectPath } })} style={{ flex: 1 }} />
        <Button title="Logs" icon="document-text-outline" kind="secondary" onPress={() => router.push({ pathname: '/host/[hostId]/logs', params: { hostId, project: projectPath } })} style={{ flex: 1 }} />
      </View>
      {/* Production servers are mostly deployed to, so Deploy comes first there. */}
      {production ? deploy : null}

      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T size="sm" weight="700" tone="dim" style={{ flex: 1, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Running apps
          </T>
          {apps.length && status.pm2 ? (
            <IconButton icon="add" label="Run another app from this project" onPress={() => router.push({ pathname: '/host/[hostId]/app-setup', params: { hostId, project: projectPath } })} />
          ) : null}
        </View>
        {apps.length ? (
          apps.map((a) => <AppCard key={a.name} hostId={hostId} client={client!} app={a} onChanged={load} />)
        ) : (
          <View style={[styles.empty, { borderColor: c.border }]}>
            <Icon name="play-circle-outline" size={28} color={c.accent} />
            <T weight="600">Nothing running from this project</T>
            <T size="sm" tone="dim" style={{ textAlign: 'center' }}>
              Start it as an app that keeps running (restarts on crash and after reboots), then give it a domain.
            </T>
            <Button
              title="Run as an app"
              icon="play"
              disabled={!status.pm2}
              onPress={() => router.push({ pathname: '/host/[hostId]/app-setup', params: { hostId, project: projectPath } })}
            />
          </View>
        )}
      </View>

      {!production ? deploy : null}

      <View style={{ gap: space.sm }}>
        <T size="sm" weight="700" tone="dim" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Quick tasks
        </T>
        {groups.length === 0 ? (
          <T tone="dim">No tasks found (no package.json, composer.json, artisan or git).</T>
        ) : (
          groups.map(({ g, items }) => (
            <View key={g} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name={GROUP[g].icon} size={14} color={c.textDim} />
                <T size="xs" weight="600" tone="dim">
                  {GROUP[g].title}
                </T>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {items.map((t) => (
                  <Pressable
                    key={t.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${t.label}: ${t.command}`}
                    disabled={running?.code === null}
                    onPress={() => void runTask(t)}
                    style={({ pressed }) => [
                      styles.task,
                      { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: c.border, opacity: running?.code === null ? 0.5 : 1 },
                    ]}
                  >
                    <T size="sm" weight="600">
                      {t.label}
                    </T>
                    <T size="xs" tone="faint" mono numberOfLines={1}>
                      {t.command}
                    </T>
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        )}
      </View>

      {running ? (
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Icon
              name={running.code === null ? 'hourglass-outline' : running.code === 0 ? 'checkmark-circle' : 'close-circle'}
              size={18}
              color={running.code === null ? c.accent : running.code === 0 ? c.success : c.danger}
            />
            <T weight="600" style={{ flex: 1 }}>
              {running.task.label}
              {running.code === null ? '…' : running.code === 0 ? ': done' : ': failed'}
            </T>
            {running.code !== null ? <IconButton icon="close" label="Hide output" onPress={() => setRunning(null)} size={18} /> : null}
          </View>
          <OutputBox text={stream.output} />
          {running.error ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't run" body={running.error} /> : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.lg, padding: space.lg, alignItems: 'center', gap: space.sm },
  task: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, flexGrow: 1, flexBasis: '45%', minHeight: 48, justifyContent: 'center' },
});
