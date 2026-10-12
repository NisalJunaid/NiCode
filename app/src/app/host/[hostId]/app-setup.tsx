import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import type { AppProcess, AppStartOptions } from '@protocol';
import { OutputBox, StepList, useTaskStream } from '@/components/TaskConsole';
import { Banner, Button, Field, Icon, IconButton, Loading, Segmented, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage, randomId } from '@/lib/util';
import { font, radius, space, useColors } from '@/theme';

/**
 * Run a project as a long-running app (pm2): how to start it, port, environment, build first.
 * Ends with "Add a domain" pre-filled with this app's port.
 */
export default function AppSetup() {
  const c = useColors();
  const { hostId, project } = useLocalSearchParams<{ hostId: string; project: string }>();
  const { client } = useConnection(hostId);
  const [opts, setOpts] = useState<AppStartOptions | null>(null);
  const [name, setName] = useState(basename(project).replace(/[^A-Za-z0-9._-]/g, '-'));
  const [mode, setMode] = useState<'script' | 'command'>('script');
  const [script, setScript] = useState('');
  const [command, setCommand] = useState('');
  const [port, setPort] = useState('');
  const [buildFirst, setBuildFirst] = useState(true);
  const [env, setEnv] = useState<{ k: string; v: string }[]>([]);
  const [opId, setOpId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AppProcess | null>(null);
  const stream = useTaskStream(client, opId);

  useOnConnected(
    client,
    useCallback(() => {
      client?.call('apps.startOptions', { projectPath: project }).then((o) => {
        setOpts(o);
        if (o.suggested?.kind === 'script') {
          setMode('script');
          setScript(o.suggested.script);
        } else if (o.suggested?.kind === 'command') {
          setMode('command');
          setCommand(o.suggested.command);
        } else if (!o.scripts.length) setMode('command');
        if (o.port) setPort(String(o.port));
        setBuildFirst(o.hasBuild);
      });
    }, [client, project]),
  );

  const envValid = env.every((e) => !e.k || /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.k));
  const valid = /^[A-Za-z0-9._-]{1,60}$/.test(name) && (mode === 'script' ? !!script : !!command.trim()) && (!port || /^\d{2,5}$/.test(port)) && envValid;

  const start = async () => {
    if (!client) return;
    const id = randomId();
    setOpId(id);
    setBusy(true);
    setError(null);
    try {
      const r = await client.call(
        'apps.create',
        {
          projectPath: project,
          name,
          start: mode === 'script' ? { kind: 'script', script } : { kind: 'command', command: command.trim() },
          ...(port ? { port: Number(port) } : {}),
          env: Object.fromEntries(env.filter((e) => e.k.trim()).map((e) => [e.k.trim(), e.v])),
          buildFirst,
          opId: id,
        },
        35 * 60_000,
      );
      setCreated(r.app);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(errorMessage(err));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  if (!opts) return <Loading />;

  // ── progress / result ──
  if (opId) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <Stack.Screen options={{ title: name }} />
        <StepList steps={stream.steps} />
        <OutputBox text={stream.output} placeholder="Output appears here…" />
        {error ? <Banner tone="danger" icon="alert-circle-outline" title="Didn't start" body={error} /> : null}
        {created ? (
          <>
            <Banner
              tone={created.listening === false ? 'warning' : 'success'}
              icon={created.listening === false ? 'alert-circle-outline' : 'checkmark-circle'}
              title={created.listening === false ? `${name} started, but port ${created.port} isn't answering yet` : `${name} is running`}
              body="pm2 restarts it if it crashes and brings it back after a reboot."
            />
            {created.port ? (
              <Button
                title="Add a domain for this app"
                icon="globe-outline"
                onPress={() => {
                  router.back();
                  router.push({ pathname: '/host/[hostId]/add-domain', params: { hostId, project, kind: 'proxy', port: String(created.port) } });
                }}
              />
            ) : null}
            <Button
              title="View app & logs"
              kind="secondary"
              onPress={() => {
                router.back();
                router.push({ pathname: '/host/[hostId]/app', params: { hostId, name } });
              }}
            />
          </>
        ) : error ? (
          <Button title="Back to the form" kind="secondary" onPress={() => setOpId(null)} />
        ) : busy ? (
          <T tone="dim" style={{ textAlign: 'center' }}>Installing and building can take a few minutes…</T>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <Stack.Screen options={{ title: `Run ${basename(project)}` }} />
        <View style={[styles.suggest, { backgroundColor: c.accentSoft }]}>
          <Icon name="sparkles-outline" size={16} color={c.accent} />
          <T size="sm" style={{ flex: 1 }}>{opts.reason}</T>
        </View>

        <Field label="App name" value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} hint="Shown in pm2 and in the app list." />

        <View style={{ gap: space.sm }}>
          <T size="sm" weight="600" tone="dim">How to start it</T>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'script', label: 'npm script' },
              { value: 'command', label: 'Command' },
            ]}
          />
          {mode === 'script' ? (
            opts.scripts.length ? (
              <View style={{ gap: 6 }}>
                {opts.scripts.map((s) => {
                  const active = s.name === script;
                  return (
                    <Pressable
                      key={s.name}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      onPress={() => setScript(s.name)}
                      style={[styles.option, { borderColor: active ? c.accent : c.border, backgroundColor: active ? c.accentSoft : c.surface }]}
                    >
                      <Icon name={active ? 'radio-button-on' : 'radio-button-off'} size={18} color={active ? c.accent : c.textFaint} />
                      <View style={{ flex: 1 }}>
                        <T weight="600">{s.name}</T>
                        <T size="xs" tone="dim" mono numberOfLines={1}>{s.command}</T>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <T size="sm" tone="dim">No start scripts in package.json. Use a command instead.</T>
            )
          ) : (
            <Field value={command} onChangeText={setCommand} placeholder="node dist/main.js" autoCapitalize="none" autoCorrect={false} style={{ fontFamily: font.mono }} hint="Runs in the project folder. e.g. node server.js · php artisan queue:work · python3 app.py" />
          )}
        </View>

        <Field label="Port (optional)" value={port} onChangeText={setPort} keyboardType="number-pad" placeholder="3000" hint="Passed to the app as PORT. Needed to add a domain." />

        {opts.hasBuild ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <T>Install & build first</T>
              <T size="sm" tone="dim">Runs the install and `build` script before starting.</T>
            </View>
            <Switch value={buildFirst} onValueChange={setBuildFirst} trackColor={{ true: c.accent, false: c.surface2 }} thumbColor="#fff" />
          </View>
        ) : null}

        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <T size="sm" weight="600" tone="dim" style={{ flex: 1 }}>Environment variables</T>
            <Button small kind="ghost" title="Add" icon="add" onPress={() => setEnv((e) => [...e, { k: '', v: '' }])} />
          </View>
          {env.length === 0 ? <T size="sm" tone="faint">None. The app also reads its own .env file, if it has one.</T> : null}
          {env.map((e, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
              <TextInput
                value={e.k}
                onChangeText={(k) => setEnv((all) => all.map((x, j) => (j === i ? { ...x, k: k.toUpperCase() } : x)))}
                placeholder="NAME"
                placeholderTextColor={c.textFaint}
                autoCapitalize="characters"
                autoCorrect={false}
                style={[styles.envInput, { flex: 2, borderColor: /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.k) || !e.k ? c.border : c.danger, color: c.text, backgroundColor: c.surface }]}
              />
              <TextInput
                value={e.v}
                onChangeText={(v) => setEnv((all) => all.map((x, j) => (j === i ? { ...x, v } : x)))}
                placeholder="value"
                placeholderTextColor={c.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.envInput, { flex: 3, borderColor: c.border, color: c.text, backgroundColor: c.surface }]}
              />
              <IconButton icon="close" label="Remove variable" size={18} onPress={() => setEnv((all) => all.filter((_, j) => j !== i))} />
            </View>
          ))}
        </View>

        <Button title={`Start ${name || 'app'}`} icon="play" disabled={!valid} onPress={start} />
        <T size="xs" tone="faint" style={{ textAlign: 'center' }}>
          Runs with pm2: restarted automatically if it crashes, and after server reboots once start-on-boot is on.
        </T>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  suggest: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: 'flex-start' },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md },
  envInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.sm, minHeight: 44, fontFamily: font.mono, fontSize: 13 },
});
