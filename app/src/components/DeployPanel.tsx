import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type DeployPlan, type DeployRecord, type DeploySteps, deployGuards } from '@protocol';
import { RpcCallError, type NicodeClient } from '@/lib/client';
import { confirmAction } from '@/lib/confirm';
import { errorMessage, randomId, relativeTime } from '@/lib/util';
import { radius, space, useColors } from '@/theme';
import { OutputBox, StepList, useTaskStream } from './TaskConsole';
import { Banner, Button, Card, type IconName, Icon, IconButton, T } from './ui';

const NONE: DeploySteps = { pull: false, install: false, build: false, migrate: false, restart: false };

const STEP_INFO: { key: keyof DeploySteps; title: string; icon: IconName }[] = [
  { key: 'pull', title: 'Pull', icon: 'cloud-download-outline' },
  { key: 'install', title: 'Install dependencies', icon: 'cube-outline' },
  { key: 'build', title: 'Build', icon: 'hammer-outline' },
  { key: 'migrate', title: 'Migrate the database', icon: 'server-outline' },
  { key: 'restart', title: 'Restart apps', icon: 'refresh-outline' },
];

/**
 * Deploying this project: Pull, Rebuild, Migrate, Restart, Start, or a full deploy with a review
 * of what's coming in. Pulls never run over local changes (stash or discard first); on production
 * servers migrations and discarding changes ask for a fingerprint.
 */
export function DeployPanel({ client, hostId, projectPath, production, onDone }: { client: NicodeClient; hostId: string; projectPath: string; production: boolean; onDone: () => void }) {
  const c = useColors();
  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [history, setHistory] = useState<DeployRecord[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [run, setRun] = useState<{ opId: string; title: string; result: DeployRecord | null; error?: string } | null>(null);
  const stream = useTaskStream(client, run?.opId ?? null);
  const busy = !!run && !run.result && !run.error;

  const load = useCallback(async () => {
    setPlanError(null);
    const [p, h] = await Promise.all([
      client.call('deploy.plan', { projectPath }, 120_000).catch((err) => {
        setPlanError(errorMessage(err));
        return null;
      }),
      client.call('deploy.history', { projectPath }).catch(() => []),
    ]);
    if (p) setPlan(p);
    setHistory(h);
  }, [client, projectPath]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Local changes on the server: ask what to do with them (null = cancel). */
  const askDirty = (dirty: string[]): Promise<'stash' | 'discard' | null> =>
    new Promise((resolve) => {
      const list = dirty.slice(0, 8).join('\n') + (dirty.length > 8 ? `\n… ${dirty.length - 8} more` : '');
      Alert.alert(
        'Uncommitted changes on the server',
        `A pull would collide with these:\n\n${list}\n\nStash keeps them (git stash list). Discard deletes them.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
          { text: 'Stash & continue', onPress: () => resolve('stash') },
          { text: 'Discard', style: 'destructive', onPress: () => resolve('discard') },
        ],
        { cancelable: true, onDismiss: () => resolve(null) },
      );
    });

  const start = async (title: string, steps: DeploySteps, onDirty?: 'stash' | 'discard'): Promise<void> => {
    if (steps.pull && !onDirty && plan?.pull?.dirty.length) {
      const choice = await askDirty(plan.pull.dirty);
      if (!choice) return;
      onDirty = choice;
    }
    let proof;
    const guards = deployGuards({ steps, onDirty });
    if (production && guards.length) {
      try {
        proof = await confirmAction(client, 'deploy.run', [projectPath, ...guards], guards.includes('migrate') ? 'Confirm migrating the production database' : 'Confirm discarding changes on production');
      } catch (err) {
        return Alert.alert('Not confirmed', errorMessage(err));
      }
    }
    const opId = randomId();
    setRun({ opId, title, result: null });
    try {
      const result = await client.call('deploy.run', { projectPath, steps, opId, ...(onDirty ? { onDirty } : {}), ...(proof ? { proof } : {}) }, 45 * 60_000);
      setRun((cur) => (cur?.opId === opId ? { ...cur, result } : cur));
      void Haptics.notificationAsync(result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
    } catch (err) {
      if (err instanceof RpcCallError && err.code === 'dirty') {
        setRun(null);
        const dirty = ((err.data as { dirty?: string[] } | undefined)?.dirty ?? []) as string[];
        const choice = await askDirty(dirty);
        if (choice) return start(title, steps, choice);
        return;
      }
      setRun((cur) => (cur?.opId === opId ? { ...cur, error: errorMessage(err) } : cur));
    }
    void load();
    onDone();
  };

  const migrate = () => {
    const m = plan?.migrate;
    if (!m) return;
    Alert.alert(
      production ? 'Migrate the production database?' : 'Run migrations?',
      `${m.command}${m.status ? `\n\n${m.status.split('\n').slice(-12).join('\n')}` : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Migrate', style: production ? 'destructive' : 'default', onPress: () => void start('Migrate', { ...NONE, migrate: true }) },
      ],
    );
  };

  const startApps = async () => {
    const stopped = plan?.apps.filter((a) => a.status !== 'online') ?? [];
    if (!plan?.apps.length) return router.push({ pathname: '/host/[hostId]/app-setup', params: { hostId, project: projectPath } });
    try {
      for (const a of stopped) await client.call('apps.action', { name: a.name, action: 'start' }, 90_000);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert("Couldn't start", errorMessage(err));
    }
    void load();
    onDone();
  };

  const pull = plan?.pull;
  const stoppedApps = plan?.apps.filter((a) => a.status !== 'online').length ?? 0;

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <T size="sm" weight="700" tone="dim" style={{ flex: 1, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Deploy
        </T>
        <IconButton icon="refresh" label="Check for updates" onPress={() => void load()} size={18} disabled={busy} />
      </View>

      {planError ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't check this project" body={planError} /> : null}
      {pull ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Icon name="git-branch-outline" size={16} color={c.textDim} />
            <T weight="600" style={{ flex: 1 }} numberOfLines={1}>
              {pull.branch ?? 'detached'}
              {pull.upstream ? ` ← ${pull.upstream}` : ''}
            </T>
            {pull.behind ? <T tone="accent" size="sm">{pull.behind} new</T> : <T tone="dim" size="sm">up to date</T>}
          </View>
          {pull.fetchError ? (
            <T size="xs" tone="warning">
              Couldn&apos;t fetch: {pull.fetchError}
            </T>
          ) : null}
          {pull.dirty.length ? (
            <T size="xs" tone="warning">
              {pull.dirty.length} uncommitted change{pull.dirty.length === 1 ? '' : 's'} on the server
            </T>
          ) : null}
          {pull.ahead ? (
            <T size="xs" tone="warning">
              {pull.ahead} local commit{pull.ahead === 1 ? '' : 's'} not on {pull.upstream}: a pull can only fast-forward
            </T>
          ) : null}
        </Card>
      ) : null}

      <View style={styles.grid}>
        <Action icon="cloud-download-outline" title="Pull" sub={pull?.behind ? `${pull.behind} new commit${pull.behind === 1 ? '' : 's'}` : 'git pull --ff-only'} disabled={busy || !pull} onPress={() => void start('Pull', { ...NONE, pull: true })} />
        <Action icon="hammer-outline" title="Rebuild" sub={plan?.build ?? (plan?.install.length ? 'Install dependencies' : 'Nothing to build')} disabled={busy || !plan || (!plan.build && !plan.install.length)} onPress={() => void start('Rebuild', { ...NONE, install: !!plan?.install.length, build: !!plan?.build })} />
        <Action icon="server-outline" title="Migrate" sub={plan?.migrate ? (plan.defaults.migrate ? 'Pending migrations' : plan.migrate.command) : 'No migrations found'} disabled={busy || !plan?.migrate} danger={production} onPress={migrate} />
        <Action icon="refresh-outline" title="Restart" sub={plan?.apps.length ? `${plan.apps.length} app${plan.apps.length === 1 ? '' : 's'} (zero downtime)` : 'No apps running'} disabled={busy || !plan?.apps.length} onPress={() => void start('Restart', { ...NONE, restart: true })} />
        <Action icon="play-outline" title="Start" sub={plan?.apps.length ? (stoppedApps ? `${stoppedApps} stopped` : 'All running') : 'Run as an app'} disabled={busy || (!!plan?.apps.length && !stoppedApps)} onPress={() => void startApps()} />
        <Action icon="rocket-outline" title="Full deploy" sub="Review, then run" disabled={busy || !plan} accent onPress={() => setReview(true)} />
      </View>

      {run ? (
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Icon
              name={!run.result && !run.error ? 'hourglass-outline' : run.result?.ok ? 'checkmark-circle' : 'close-circle'}
              size={18}
              color={!run.result && !run.error ? c.accent : run.result?.ok ? c.success : c.danger}
            />
            <T weight="600" style={{ flex: 1 }}>
              {run.title}
              {!run.result && !run.error ? '…' : run.result?.ok ? ': done' : ': failed'}
            </T>
            {!busy ? <IconButton icon="close" label="Hide" onPress={() => setRun(null)} size={18} /> : null}
          </View>
          <StepList steps={stream.steps.length ? stream.steps : (run.result?.steps ?? [])} />
          {stream.output ? <OutputBox text={stream.output} height={200} /> : null}
          {run.error ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't deploy" body={run.error} /> : null}
        </View>
      ) : null}

      {history.length ? (
        <Card>
          <T size="xs" weight="600" tone="dim">
            Recent deploys
          </T>
          {history.slice(0, 5).map((h) => (
            <View key={h.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Icon name={h.ok ? 'checkmark-circle' : 'close-circle'} size={14} color={h.ok ? c.success : c.danger} />
              <T size="xs" style={{ flex: 1 }} numberOfLines={1}>
                {h.steps.filter((s) => s.status === 'done').map((s) => s.label).join(' → ') || 'Nothing ran'}
              </T>
              <T size="xs" tone="dim" mono>
                {h.before && h.after && h.before !== h.after ? `${h.before}→${h.after}` : (h.after ?? '')}
              </T>
              <T size="xs" tone="faint">
                {relativeTime(h.finishedAt)}
              </T>
            </View>
          ))}
        </Card>
      ) : null}

      {plan && review ? <ReviewSheet visible plan={plan} production={production} onClose={() => setReview(false)} onDeploy={(s) => { setReview(false); void start('Deploy', s); }} /> : null}
    </View>
  );
}

function Action({ icon, title, sub, disabled, danger, accent, onPress }: { icon: IconName; title: string; sub: string; disabled?: boolean; danger?: boolean; accent?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${sub}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: pressed ? c.surfacePressed : accent ? c.accentSoft : c.surface, borderColor: accent ? c.accent : c.border, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name={icon} size={16} color={danger ? c.danger : c.accent} />
        <T size="sm" weight="600">
          {title}
        </T>
      </View>
      <T size="xs" tone="faint" numberOfLines={1}>
        {sub}
      </T>
    </Pressable>
  );
}

/** What a full deploy would do, with a switch per step. */
function ReviewSheet({ visible, plan, production, onClose, onDeploy }: { visible: boolean; plan: DeployPlan; production: boolean; onClose: () => void; onDeploy: (s: DeploySteps) => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // Mounted only while open (see DeployPanel), so every review starts from the suggested steps.
  const [steps, setSteps] = useState<DeploySteps>(plan.defaults);
  const available: Record<keyof DeploySteps, boolean> = {
    pull: !!plan.pull,
    install: plan.install.length > 0,
    build: !!plan.build,
    migrate: !!plan.migrate,
    restart: plan.apps.length > 0,
  };
  const detail: Record<keyof DeploySteps, string> = {
    pull: plan.pull ? (plan.pull.behind ? `${plan.pull.behind} new commit${plan.pull.behind === 1 ? '' : 's'}` : 'Already up to date') : 'Not a git repository',
    install: plan.install.join(' · ') || 'Nothing to install',
    build: plan.build ?? 'No build script',
    migrate: plan.migrate ? `${plan.migrate.command}${production ? ' (fingerprint)' : ''}` : 'No migrations found',
    restart: plan.apps.length ? plan.apps.map((a) => a.name).join(', ') : 'No pm2 apps for this project',
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: c.overlay }]} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + space.lg }]} onPress={() => undefined}>
          <ScrollView contentContainerStyle={{ gap: space.sm }}>
            <T size="lg" weight="700">
              Deploy {production ? 'to production' : ''}
            </T>
            {plan.pull?.incoming.length ? (
              <View style={{ gap: 2 }}>
                <T size="sm" weight="600" tone="dim">
                  Coming in
                </T>
                {plan.pull.incoming.slice(0, 10).map((m) => (
                  <T key={m.hash} size="xs" numberOfLines={1}>
                    <T size="xs" mono tone="accent">
                      {m.hash}
                    </T>{' '}
                    {m.subject} <T size="xs" tone="faint">· {m.author}</T>
                  </T>
                ))}
                {plan.pull.incoming.length > 10 ? (
                  <T size="xs" tone="faint">
                    … {plan.pull.incoming.length - 10} more
                  </T>
                ) : null}
              </View>
            ) : null}
            {plan.pull?.dirty.length ? (
              <Banner tone="warning" icon="alert-circle-outline" title={`${plan.pull.dirty.length} uncommitted change(s) on the server`} body="You'll be asked to stash or discard them before the pull." />
            ) : null}
            {plan.migrate?.status && steps.migrate ? (
              <View style={{ backgroundColor: c.codeBg, borderRadius: radius.sm, padding: space.sm }}>
                <T mono size="xs" numberOfLines={10}>
                  {plan.migrate.status.split('\n').slice(-10).join('\n')}
                </T>
              </View>
            ) : null}
            {STEP_INFO.map((s) => (
              <View key={s.key} style={[styles.toggle, { borderColor: c.border, opacity: available[s.key] ? 1 : 0.45 }]}>
                <Icon name={s.icon} size={18} color={s.key === 'migrate' && production ? c.danger : c.accent} />
                <View style={{ flex: 1 }}>
                  <T weight="600">{s.title}</T>
                  <T size="xs" tone="dim" numberOfLines={2}>
                    {detail[s.key]}
                  </T>
                </View>
                <Switch value={steps[s.key] && available[s.key]} disabled={!available[s.key]} onValueChange={(v) => setSteps((cur) => ({ ...cur, [s.key]: v }))} />
              </View>
            ))}
            <Button title={production ? 'Deploy to production' : 'Deploy'} icon="rocket-outline" disabled={!Object.values(steps).some(Boolean)} onPress={() => onDeploy(steps)} />
            <Button kind="ghost" title="Cancel" onPress={onClose} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, flexGrow: 1, flexBasis: '45%', minHeight: 56, justifyContent: 'center', gap: 2 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, maxHeight: '85%' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md },
});
