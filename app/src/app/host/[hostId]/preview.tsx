import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { AppProcess, DevOptions, DevServer, PreviewStatus, Site } from '@protocol';
import { OutputBox, StepList, useTaskStream } from '@/components/TaskConsole';
import { Banner, Button, EmptyState, Icon, IconButton, Loading, Segmented, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage, randomId } from '@/lib/util';
import { useSettings } from '@/state/settings';
import { radius, space, useColors } from '@/theme';

type Source = 'dev' | 'app' | 'domain';
type Target = { source: Source; label: string; port?: number; url: string };

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Lay the page out like a laptop screen, then let the WebView zoom it to fit.
const DESKTOP_JS = `(function(){var m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';(document.head||document.documentElement).appendChild(m);}m.content='width=1280';})();true;`;

/**
 * Live preview of a project: its dev server (hot reload), a running app, or a linked domain,
 * in an in-app browser. Ports open on their own HTTPS address through the server (no domain needed).
 */
export default function Preview() {
  const c = useColors();
  const params = useLocalSearchParams<{ hostId: string; project: string; source?: Source; port?: string; domain?: string }>();
  const { hostId, project } = params;
  const { client } = useConnection(hostId);
  const lastPreview = useSettings((s) => s.lastPreview);
  const setSettings = useSettings((s) => s.set);

  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [devOpts, setDevOpts] = useState<DevOptions | null>(null);
  const [dev, setDev] = useState<DevServer | null>(null);
  const [devLog, setDevLog] = useState('');
  const [apps, setApps] = useState<AppProcess[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [tab, setTab] = useState<Source>(params.source ?? lastPreview[project] ?? 'dev');
  const [opId, setOpId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [showConsole, setShowConsole] = useState(false);
  const steps = useTaskStream(client, opId);
  const devStream = useTaskStream(client, dev?.opId ?? null);

  const remember = (s: Source) => setSettings({ lastPreview: { ...useSettings.getState().lastPreview, [project]: s } });

  const openPort = useCallback(
    async (source: Source, port: number, label: string) => {
      if (!client) return;
      const id = randomId();
      setOpId(id);
      setError(null);
      setBusy('open');
      try {
        const link = await client.call('preview.open', { port, opId: id }, 6 * 60_000);
        setTarget({ source, label, port, url: link.url });
        remember(source);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, project],
  );

  const openDomain = (s: Site) => {
    const d = s.domains[0]!;
    setTarget({ source: 'domain', label: d, url: `${s.https ? 'https' : 'http'}://${d}` });
    remember('domain');
  };

  useOnConnected(
    client,
    useCallback(() => {
      if (!client) return;
      void (async () => {
        const [st, opts, ds, list, ss] = await Promise.all([
          client.call('preview.status', {}).catch(() => ({ supported: false, reason: 'This server needs a niCode update for previews (sudo nicode update).' })),
          client.call('preview.devOptions', { projectPath: project }).catch(() => null),
          client.call('preview.devStatus', { projectPath: project }).catch(() => null),
          client.call('apps.list', {}).catch(() => [] as AppProcess[]),
          client.call('sites.list', {}).catch(() => [] as Site[]),
        ]);
        setStatus(st);
        setDevOpts(opts);
        setDev(ds?.dev && ds.dev.state !== 'exited' ? ds.dev : null);
        setDevLog(ds?.output ?? '');
        const projApps = list.filter((a) => a.projectPath === project && a.port);
        const projSites = ss.filter((s) => s.projectPath === project && s.enabled && s.domains.length);
        setApps(projApps);
        setSites(projSites);
        setLoaded(true);
        // Deep links straight to something: open it.
        if (params.domain) {
          const s = projSites.find((x) => x.domains.includes(params.domain!)) ?? ss.find((x) => x.domains.includes(params.domain!));
          if (s) openDomain(s);
        } else if (params.port) {
          setTab('app');
          void openPort('app', Number(params.port), `Port ${params.port}`);
        } else if (!params.source && !lastPreview[project]) {
          setTab(ds?.dev && ds.dev.state !== 'exited' ? 'dev' : projApps.length ? 'app' : projSites.length ? 'domain' : 'dev');
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, project]),
  );

  const startDev = async () => {
    if (!client) return;
    const id = randomId();
    setError(null);
    setBusy('dev');
    setDevLog('');
    setDev({ projectPath: project, port: 0, command: devOpts?.command ?? '', framework: devOpts?.framework ?? null, state: 'starting', startedAt: new Date().toISOString(), exitCode: null, opId: id });
    try {
      const d = await client.call('preview.devStart', { projectPath: project, opId: id }, 150_000);
      setDev(d);
      await openPort('dev', d.port, `Dev server · :${d.port}`);
    } catch (err) {
      setError(errorMessage(err));
      setShowConsole(true);
      setDev((cur) => (cur ? { ...cur, state: 'exited' } : cur));
    } finally {
      setBusy(null);
    }
  };
  const stopDev = async () => {
    await client?.call('preview.devStop', { projectPath: project }).catch(() => undefined);
    setDev(null);
    if (target?.source === 'dev') setTarget(null);
  };

  if (!loaded || !status) return <Loading />;

  if (target) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Stack.Screen options={{ title: basename(project) }} />
        <PreviewBrowser
          target={target}
          onChange={() => setTarget(null)}
          onConsole={target.source === 'dev' ? () => setShowConsole((v) => !v) : undefined}
          console={target.source === 'dev' && showConsole ? devLog + devStream.output : null}
          reopen={async () => (target.port && client ? (await client.call('preview.open', { port: target.port })).url : target.url)}
        />
      </View>
    );
  }

  const available: { value: Source; label: string }[] = [
    { value: 'dev', label: 'Dev server' },
    { value: 'app', label: 'Running app' },
    { value: 'domain', label: 'Domain' },
  ];
  const portsBlocked = !status.supported;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: `Preview ${basename(project)}` }} />
      <Segmented value={tab} onChange={setTab} options={available} />

      {portsBlocked && tab !== 'domain' ? <Banner tone="warning" icon="information-circle-outline" title="Port previews aren't available" body={status.reason} /> : null}

      {tab === 'dev' ? (
        <View style={{ gap: space.md }}>
          <T tone="dim">
            Runs this project&apos;s dev server on the server with hot reload, so you see Claude&apos;s changes as they happen. It stops by itself after 2 hours unused.
          </T>
          {!devOpts?.available ? (
            <EmptyState icon="code-slash-outline" title="No dev script" body={devOpts?.reason ?? 'Add a "dev" script to package.json.'} />
          ) : (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Icon name="flash-outline" size={18} color={c.accent} />
                <T weight="700" style={{ flex: 1 }}>
                  {devOpts.framework ?? 'Dev server'}
                </T>
                {dev?.state === 'running' ? <T size="xs" tone="dim">running on :{dev.port}</T> : null}
              </View>
              <T size="xs" tone="faint" mono>
                {dev?.command || devOpts.command}
              </T>
              {dev?.state === 'running' ? (
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Button title="Open preview" icon="eye-outline" disabled={portsBlocked} loading={busy === 'open'} onPress={() => void openPort('dev', dev.port, `Dev server · :${dev.port}`)} style={{ flex: 1 }} />
                  <Button title="Stop" icon="stop" kind="secondary" onPress={() => void stopDev()} />
                </View>
              ) : (
                <Button title="Start dev server" icon="play" disabled={portsBlocked} loading={busy === 'dev'} onPress={() => void startDev()} />
              )}
            </View>
          )}
          {dev && (busy === 'dev' || showConsole || dev.state === 'exited') ? <OutputBox text={devLog + devStream.output} placeholder="Starting…" height={220} /> : null}
        </View>
      ) : null}

      {tab === 'app' ? (
        <View style={{ gap: space.sm }}>
          {apps.length === 0 ? (
            <EmptyState
              icon="play-circle-outline"
              title="No running app with a port"
              body="Run this project as an app (Run tab) with a port, then preview it here."
              action={<Button small title="Run as an app" onPress={() => router.push({ pathname: '/host/[hostId]/app-setup', params: { hostId, project } })} />}
            />
          ) : (
            apps.map((a) => (
              <Pressable
                key={a.name}
                accessibilityRole="button"
                disabled={portsBlocked || !!busy}
                onPress={() => void openPort('app', a.port!, `${a.name} · :${a.port}`)}
                style={({ pressed }) => [styles.card, { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: c.border, flexDirection: 'row', alignItems: 'center' }]}
              >
                <Icon name="cube-outline" size={20} color={c.accent} />
                <View style={{ flex: 1 }}>
                  <T weight="600">{a.name}</T>
                  <T size="sm" tone="dim">
                    port {a.port} · {a.status}
                  </T>
                </View>
                <Icon name="eye-outline" size={20} color={c.textDim} />
              </Pressable>
            ))
          )}
        </View>
      ) : null}

      {tab === 'domain' ? (
        <View style={{ gap: space.sm }}>
          {sites.length === 0 ? (
            <EmptyState
              icon="globe-outline"
              title="No domain linked"
              body="Add a domain for this project to see it exactly like visitors do."
              action={<Button small title="Add a domain" onPress={() => router.push({ pathname: '/host/[hostId]/add-domain', params: { hostId, project } })} />}
            />
          ) : (
            sites.map((s) => (
              <Pressable
                key={s.name}
                accessibilityRole="button"
                onPress={() => openDomain(s)}
                style={({ pressed }) => [styles.card, { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: c.border, flexDirection: 'row', alignItems: 'center' }]}
              >
                <Icon name={s.https ? 'lock-closed-outline' : 'globe-outline'} size={20} color={c.accent} />
                <T weight="600" style={{ flex: 1 }} numberOfLines={1}>
                  {s.domains[0]}
                </T>
                <Icon name="eye-outline" size={20} color={c.textDim} />
              </Pressable>
            ))
          )}
        </View>
      ) : null}

      <StepList steps={steps.steps} />
      {error ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't open the preview" body={error} /> : null}
    </ScrollView>
  );
}

function PreviewBrowser({ target, onChange, onConsole, console: consoleText, reopen }: { target: Target; onChange: () => void; onConsole?: () => void; console: string | null; reopen: () => Promise<string> }) {
  const c = useColors();
  const ref = useRef<WebView>(null);
  const [nav, setNav] = useState({ back: false, forward: false, url: target.url, loading: true });
  const [desktop, setDesktop] = useState(false);
  const [src, setSrc] = useState(target.url);
  const [failed, setFailed] = useState<string | null>(null);

  const toggleDesktop = () => {
    setSrc(nav.url); // remount at the current page (already signed in)
    setDesktop((d) => !d);
  };
  const openExternal = async () => {
    try {
      await Linking.openURL(await reopen());
    } catch {
      // ignore
    }
  };
  const shown = (() => {
    try {
      const u = new URL(nav.url);
      return u.pathname.startsWith('/__nicode/') ? target.label : `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      return target.label;
    }
  })();

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.bar, { borderBottomColor: c.border, backgroundColor: c.surface }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Change what to preview" onPress={onChange} style={[styles.chip, { backgroundColor: c.surface2 }]}>
          <Icon name={target.source === 'domain' ? 'globe-outline' : target.source === 'dev' ? 'flash-outline' : 'cube-outline'} size={14} color={c.accent} />
          <T size="xs" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {shown}
          </T>
          <Icon name="chevron-down" size={12} color={c.textDim} />
        </Pressable>
        {onConsole ? <IconButton icon="terminal-outline" label="Dev server output" onPress={onConsole} size={18} /> : null}
      </View>
      {consoleText !== null ? (
        <View style={{ padding: space.sm }}>
          <OutputBox text={consoleText} height={180} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <WebView
          key={desktop ? 'desktop' : 'phone'}
          ref={ref}
          source={{ uri: src }}
          style={{ flex: 1, backgroundColor: '#fff' }}
          userAgent={desktop ? DESKTOP_UA : undefined}
          injectedJavaScript={desktop ? DESKTOP_JS : undefined}
          scalesPageToFit
          setBuiltInZoomControls={desktop}
          setDisplayZoomControls={false}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          mixedContentMode="compatibility"
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          onNavigationStateChange={(s) => setNav({ back: s.canGoBack, forward: s.canGoForward, url: s.url, loading: s.loading })}
          onLoadStart={() => setFailed(null)}
          onError={(e) => setFailed(e.nativeEvent.description || 'The page could not be loaded')}
          onHttpError={(e) => e.nativeEvent.statusCode >= 500 && setFailed(`The server answered ${e.nativeEvent.statusCode}`)}
        />
        {failed ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg, padding: space.lg, justifyContent: 'center' }]}>
            <Banner tone="danger" icon="cloud-offline-outline" title="Couldn't load the page" body={failed} action={<Button small title="Retry" onPress={() => ref.current?.reload()} />} />
          </View>
        ) : null}
      </View>
      <View style={[styles.toolbar, { borderTopColor: c.border, backgroundColor: c.surface }]}>
        <IconButton icon="chevron-back" label="Back" disabled={!nav.back} onPress={() => ref.current?.goBack()} />
        <IconButton icon="chevron-forward" label="Forward" disabled={!nav.forward} onPress={() => ref.current?.goForward()} />
        <IconButton icon={nav.loading ? 'close' : 'refresh'} label={nav.loading ? 'Stop loading' : 'Reload'} onPress={() => (nav.loading ? ref.current?.stopLoading() : ref.current?.reload())} />
        <IconButton icon={desktop ? 'phone-portrait-outline' : 'desktop-outline'} label={desktop ? 'Phone width' : 'Desktop width'} onPress={toggleDesktop} />
        <IconButton icon="open-outline" label="Open in browser" onPress={() => void openExternal()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  chip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 32, borderRadius: radius.pill },
  toolbar: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 2 },
});
