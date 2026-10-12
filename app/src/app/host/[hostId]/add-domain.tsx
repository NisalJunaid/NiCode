import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import type { DnsCheck, Project, Site, SiteKind, SitesStatus, SiteSuggestion } from '@protocol';
import { SiteProgress, useSiteProgress } from '@/components/SiteProgress';
import { Banner, Button, Card, EmptyState, Field, Icon, Loading, Segmented, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage, pathKey, randomId } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

const KINDS: { value: SiteKind; label: string }[] = [
  { value: 'static', label: 'Static' },
  { value: 'spa', label: 'Web app' },
  { value: 'php', label: 'PHP' },
  { value: 'proxy', label: 'Port' },
];
const KIND_HELP: Record<SiteKind, string> = {
  static: 'Serves files as they are (HTML, CSS, images).',
  spa: 'Single-page app (React, Vue, Vite build): unknown paths load index.html.',
  php: 'Runs PHP through php-fpm (Laravel, WordPress, plain PHP).',
  proxy: 'Forwards visitors to an app running on the server (Node, Next.js, Python…).',
};

/**
 * One-click domain setup: domain → project (existing or new folder) → how to serve it → HTTPS.
 * Each section explains itself; sensible defaults are filled in from the project.
 */
export default function AddDomain() {
  const c = useColors();
  const { hostId, project: projectParam, kind: kindParam, port: portParam } = useLocalSearchParams<{ hostId: string; project?: string; kind?: SiteKind; port?: string }>();
  const { client } = useConnection(hostId);

  const [status, setStatus] = useState<SitesStatus | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [domain, setDomain] = useState('');
  const [www, setWww] = useState(true);
  const [dns, setDns] = useState<DnsCheck | null>(null);
  const [dnsBusy, setDnsBusy] = useState(false);
  const [target, setTarget] = useState<'existing' | 'new'>(projectParam ? 'existing' : 'existing');
  const [projectPath, setProjectPath] = useState<string | null>(projectParam ?? null);
  const [folder, setFolder] = useState('');
  const [suggestion, setSuggestion] = useState<SiteSuggestion | null>(null);
  const [kind, setKind] = useState<SiteKind>(kindParam ?? 'static');
  const [webRoot, setWebRoot] = useState('');
  const [port, setPort] = useState(portParam ?? '3000');
  const [php, setPhp] = useState<string | null>(null);
  const [https, setHttps] = useState(true);
  const [email, setEmail] = useState('');
  const [opId, setOpId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ site: Site; log: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const steps = useSiteProgress(client, opId);
  const dnsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useOnConnected(
    client,
    useCallback(() => {
      client?.call('sites.status', {}).then((s) => {
        setStatus(s);
        setPhp((p) => p ?? s.phpVersions[0] ?? null);
      });
      client?.call('projects.list', {}).then(setProjects);
    }, [client]),
  );

  // Suggest how to serve the chosen project.
  useEffect(() => {
    // Coming from an app (kind/port given): keep those instead of guessing.
    if (!client || target !== 'existing' || !projectPath || kindParam) return;
    let cancelled = false;
    client.call('sites.detect', { projectPath }).then((s) => {
      if (cancelled) return;
      setSuggestion(s);
      setKind(s.kind);
      setWebRoot(s.webRoot);
      if (s.port) setPort(String(s.port));
    });
    return () => {
      cancelled = true;
    };
  }, [client, target, projectPath, kindParam]);

  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const domainOk = /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(clean);

  const checkDns = useCallback(async (d: string) => {
    if (!client) return;
    setDnsBusy(true);
    try {
      setDns(await client.call('sites.checkDns', { domain: d }));
    } catch {
      setDns(null);
    } finally {
      setDnsBusy(false);
    }
  }, [client]);

  const onDomain = (t: string) => {
    setDomain(t);
    setDns(null);
    const d = t.trim().toLowerCase();
    if (!folder || folder === suggestedFolder(domain)) setFolder(suggestedFolder(t));
    if (dnsTimer.current) clearTimeout(dnsTimer.current);
    if (/^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(d)) dnsTimer.current = setTimeout(() => void checkDns(d), 700);
  };

  const submit = async () => {
    if (!client) return;
    const id = randomId();
    setOpId(id);
    setRunning(true);
    setError(null);
    try {
      const r = await client.call(
        'sites.create',
        {
          domain: clean,
          includeWww: www,
          project: target === 'new' ? { newFolder: folder } : { path: projectPath! },
          kind,
          webRoot: kind === 'proxy' ? '' : webRoot.replace(/^\/+|\/+$/g, ''),
          ...(kind === 'proxy' ? { port: Number(port) } : {}),
          ...(kind === 'php' && php ? { phpVersion: php } : {}),
          https,
          ...(email.trim() ? { email: email.trim() } : {}),
          opId: id,
        },
        420_000,
      );
      setResult(r);
      void Haptics.notificationAsync(r.site.https || !https ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    } catch (err) {
      setError(errorMessage(err));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setRunning(false);
    }
  };

  if (!status || !projects) return <Loading />;
  if (!status.supported) return <EmptyState icon="globe-outline" title="Domains aren't available here" body={status.reason} />;

  // ── progress / result view ──
  if (opId) {
    const live = result?.site;
    return (
      <Screen>
        <Stack.Screen options={{ title: clean }} />
        <SiteProgress steps={steps} />
        {error ? <Banner tone="danger" icon="alert-circle-outline" title="Setup stopped" body={error} /> : null}
        {live ? (
          <Banner
            tone={live.https || !https ? 'success' : 'warning'}
            icon={live.https ? 'lock-closed' : 'globe-outline'}
            title={live.https ? `https://${clean} is live` : `http://${clean} is live`}
            body={!live.https && https ? 'HTTPS can be added from the site page once DNS points here.' : undefined}
          />
        ) : null}
        {result ? (
          <View style={{ gap: space.sm }}>
            <Button title="Open site" icon="open-outline" onPress={() => void WebBrowser.openBrowserAsync(`${live?.https ? 'https' : 'http'}://${clean}`)} />
            {live?.projectPath ? (
              <Button
                title="Open project"
                kind="secondary"
                icon="folder-open-outline"
                onPress={() => {
                  router.back();
                  router.push({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(live.projectPath!) } });
                }}
              />
            ) : null}
            <Button title="Done" kind="ghost" onPress={() => router.back()} />
          </View>
        ) : error ? (
          <Button title="Back to the form" kind="secondary" onPress={() => setOpId(null)} />
        ) : running ? (
          <T tone="dim" style={{ textAlign: 'center' }}>This can take a minute while the certificate is issued…</T>
        ) : null}
      </Screen>
    );
  }

  const canSubmit = domainOk && (target === 'new' ? /^[A-Za-z0-9._-]{1,100}$/.test(folder) : !!projectPath) && (kind !== 'proxy' || /^\d{2,5}$/.test(port));

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <KeyboardAwareScrollView bottomOffset={24} style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <Stack.Screen options={{ title: 'Add a domain' }} />

        {/* 1. Domain */}
        <Step n={1} title="Domain" />
        <Field placeholder="shop.example.com" value={domain} onChangeText={onDomain} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <ToggleRow label={`Also use www.${clean || 'domain'}`} value={www} onChange={setWww} />
        {domainOk ? <DnsStatus dns={dns} busy={dnsBusy} serverIp={status.serverIp} includeWww={www} onRecheck={() => void checkDns(clean)} /> : null}

        {/* 2. Project */}
        <Step n={2} title="Project" />
        <Segmented
          value={target}
          onChange={setTarget}
          options={[
            { value: 'existing', label: 'Existing project' },
            { value: 'new', label: 'New folder' },
          ]}
        />
        {target === 'new' ? (
          <Field value={folder} onChangeText={setFolder} placeholder="my-site" autoCapitalize="none" autoCorrect={false} hint={`Created in ${projects[0] ? projects[0].path.replace(/\/[^/]+$/, '') : 'the projects folder'}`} />
        ) : projects.length === 0 ? (
          <T tone="dim">No projects yet; choose “New folder”.</T>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {projects.map((p) => (
              <Chip key={p.path} label={p.name} active={projectPath === p.path} onPress={() => setProjectPath(p.path)} />
            ))}
          </View>
        )}

        {/* 3. How to serve it */}
        <Step n={3} title="How to serve it" />
        {suggestion && target === 'existing' ? (
          <View style={[styles.suggest, { backgroundColor: c.accentSoft }]}>
            <Icon name="sparkles-outline" size={16} color={c.accent} />
            <T size="sm" style={{ flex: 1 }}>{suggestion.reason}</T>
          </View>
        ) : null}
        <Segmented value={kind} onChange={setKind} options={KINDS} />
        <T size="sm" tone="dim">{KIND_HELP[kind]}</T>
        {kind === 'proxy' ? (
          <Field label="App port" value={port} onChangeText={setPort} keyboardType="number-pad" hint="The port your app listens on (keep it running, e.g. with pm2 or Docker)." />
        ) : (
          <Field
            label="Folder to serve"
            value={webRoot}
            onChangeText={setWebRoot}
            placeholder="(project root)"
            autoCapitalize="none"
            autoCorrect={false}
            hint={`${target === 'new' ? folder || 'new-folder' : basename(projectPath ?? 'project')}/${webRoot || ''}`}
          />
        )}
        {kind === 'php' ? (
          status.phpVersions.length ? (
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <T size="sm" tone="dim">PHP</T>
              {status.phpVersions.map((v) => (
                <Chip key={v} label={v} active={php === v} onPress={() => setPhp(v)} />
              ))}
            </View>
          ) : (
            <Banner tone="warning" icon="alert-circle-outline" title="php-fpm not found" body="Install PHP-FPM on the server first (or ask Claude to)." />
          )
        ) : null}

        {/* 4. HTTPS */}
        <Step n={4} title="HTTPS" />
        <ToggleRow label="Free HTTPS certificate (Let's Encrypt)" value={https} onChange={setHttps} />
        {https ? (
          <>
            {dns && !dns.pointsHere ? (
              <T size="sm" tone="warning">
                The domain doesn&apos;t point here yet, so the certificate step will likely fail. The site is still set up on http and you can add HTTPS later.
              </T>
            ) : null}
            <Field label="Email for certificate notices (optional)" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" />
          </>
        ) : null}

        <Button title={domainOk ? `Set up ${clean}` : 'Set up domain'} icon="rocket-outline" disabled={!canSubmit} onPress={submit} />
        <T size="xs" tone="faint" style={{ textAlign: 'center' }}>
          niCode tests the nginx config before reloading and undoes the change if nginx rejects it.
        </T>
      </KeyboardAwareScrollView>
    </KeyboardAvoidingView>
  );
}

function suggestedFolder(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').slice(0, 60);
}

function Screen({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      {children}
    </ScrollView>
  );
}

function Step({ n, title }: { n: number; title: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
        <T size="xs" weight="700" style={{ color: c.onAccent }}>{n}</T>
      </View>
      <T weight="700" size="lg">{title}</T>
    </View>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <T style={{ flex: 1 }}>{label}</T>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: c.accent, false: c.surface2 }} thumbColor="#fff" />
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? c.accentSoft : c.surface, borderColor: active ? c.accent : c.border }]}
    >
      <T size="sm" weight={active ? '600' : '500'} style={{ color: active ? c.accent : c.text }}>{label}</T>
    </Pressable>
  );
}

/** Live "does this domain point here?" with copy-ready DNS instructions when it doesn't. */
function DnsStatus({ dns, busy, serverIp, includeWww, onRecheck }: { dns: DnsCheck | null; busy: boolean; serverIp: string | null; includeWww: boolean; onRecheck: () => void }) {
  const c = useColors();
  if (busy || !dns) {
    return (
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <ActivityIndicator size="small" color={c.accent} />
        <T size="sm" tone="dim">Checking DNS…</T>
      </View>
    );
  }
  if (dns.pointsHere) {
    return (
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <Icon name="checkmark-circle" size={18} color={c.success} />
        <T size="sm" tone="success">Points to this server ({dns.serverIp})</T>
      </View>
    );
  }
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
        <Icon name="alert-circle-outline" size={18} color={c.warning} />
        <T weight="600" style={{ flex: 1 }}>
          {dns.addresses.length ? `Points to ${dns.addresses.join(', ')}, not this server` : 'No DNS record yet'}
        </T>
      </View>
      <T size="sm" tone="dim">At your domain registrar (DNS settings), add these records. Some registrars want only the part before your domain, or “@” for the domain itself.</T>
      <View style={{ backgroundColor: c.codeBg, borderRadius: radius.sm, padding: space.md, gap: 4 }}>
        <T mono size="sm" selectable>A  {dns.domain}  →  {serverIp ?? '(server IP)'}</T>
        {includeWww ? <T mono size="sm" selectable>A  www.{dns.domain}  →  {serverIp ?? '(server IP)'}</T> : null}
      </View>
      <T size="xs" tone="faint">Changes usually show up within minutes (sometimes up to an hour). You can continue now; HTTPS can be added later.</T>
      <Button small kind="secondary" title="Check again" icon="refresh" onPress={onRecheck} />
    </Card>
  );
}

const styles = StyleSheet.create({
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 38, justifyContent: 'center' },
  suggest: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: 'flex-start' },
});
