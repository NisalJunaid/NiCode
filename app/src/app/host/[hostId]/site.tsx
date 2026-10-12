import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import type { Site } from '@protocol';
import { SiteProgress, useSiteProgress } from '@/components/SiteProgress';
import { Banner, Badge, Button, Divider, EmptyState, Loading, Row, Screen, Section, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { certBadge, KIND_LABEL } from '@/lib/sites';
import { basename, errorMessage, pathKey, randomId } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

/** One website: open it, switch it on/off, add HTTPS, see its nginx config, remove it. */
export default function SiteDetail() {
  const c = useColors();
  const { hostId, name } = useLocalSearchParams<{ hostId: string; name: string }>();
  const { client } = useConnection(hostId);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const steps = useSiteProgress(client, opId);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const all = await client.call('sites.list', {});
      setSite(all.find((s) => s.name === name) ?? null);
      if (!all.some((s) => s.name === name)) setError('This site no longer exists.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client, name]);
  useOnConnected(client, load);

  if (error && !site) return <EmptyState icon="alert-circle-outline" title="Site not found" body={error} />;
  if (!site) return <Loading />;

  const domain = site.domains[0] ?? site.name;
  const cert = certBadge(site);

  const setEnabled = async (enabled: boolean) => {
    setBusy('toggle');
    try {
      setSite(await client!.call('sites.setEnabled', { name, enabled }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('That didn\'t work', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const enableHttps = async () => {
    const id = randomId();
    setOpId(id);
    setBusy('https');
    try {
      const r = await client!.call('sites.enableHttps', { name, opId: id }, 360_000);
      setSite(r.site);
      void Haptics.notificationAsync(r.site.https ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    } catch (err) {
      Alert.alert('HTTPS setup failed', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = () =>
    Alert.alert(`Remove ${domain}?`, 'Deletes the nginx site (and its certificate). Your project files are kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await client!.call('sites.remove', { name }, 180_000);
            router.back();
          } catch (err) {
            Alert.alert('Couldn\'t remove', errorMessage(err));
          }
        },
      },
    ]);

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: domain }} />
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        <Badge text={site.enabled ? 'Online' : 'Disabled'} tone={site.enabled ? 'success' : 'default'} />
        <Badge text={cert.text} tone={cert.tone} />
        <Badge text={KIND_LABEL[site.kind]} />
      </View>

      {site.enabled ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button
            title="View"
            icon="eye-outline"
            onPress={() =>
              site.projectPath
                ? router.push({ pathname: '/host/[hostId]/preview', params: { hostId, project: site.projectPath, source: 'domain', domain } })
                : void WebBrowser.openBrowserAsync(`${site.https ? 'https' : 'http'}://${domain}`)
            }
            style={{ flex: 1 }}
          />
          {site.projectPath ? (
            <Button
              title="Open project"
              icon="folder-open-outline"
              kind="secondary"
              onPress={() => router.push({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(site.projectPath!) } })}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
      ) : null}

      {site.protected ? <Banner tone="accent" icon="shield-checkmark-outline" title="niCode's own address" body="This site connects the app to the server, so it can't be changed here." /> : null}

      {!site.https && site.enabled && !site.protected ? (
        <Banner
          tone="warning"
          icon="lock-open-outline"
          title="Not secured with HTTPS"
          body="Get a free Let's Encrypt certificate. The domain must already point to this server."
          action={<Button small title="Enable HTTPS" icon="lock-closed-outline" loading={busy === 'https'} onPress={enableHttps} />}
        />
      ) : null}
      {opId ? <SiteProgress steps={steps} only={['certbot']} /> : null}

      <Section title="Website">
        <Row
          icon="power-outline"
          title="Online"
          subtitle={site.enabled ? 'nginx is serving this site' : 'Switched off: nginx ignores it'}
          chevron={false}
          right={
            <Switch
              value={site.enabled}
              disabled={site.protected || busy === 'toggle'}
              onValueChange={(v) =>
                v
                  ? void setEnabled(true)
                  : Alert.alert(`Take ${domain} offline?`, 'Nothing is deleted; switch it back on any time.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Disable', style: 'destructive', onPress: () => void setEnabled(false) },
                    ])
              }
              trackColor={{ true: c.success, false: c.surface2 }}
              thumbColor="#fff"
            />
          }
        />
        <Divider />
        <Row icon="globe-outline" title="Domains" subtitle={site.domains.join(', ') || '—'} chevron={false} />
        <Divider />
        {site.kind === 'proxy' ? (
          <Row icon="swap-horizontal-outline" title="Forwards to" subtitle={`127.0.0.1:${site.proxyPort}`} chevron={false} />
        ) : (
          <Row icon="folder-outline" title="Serves" subtitle={site.root ?? '—'} chevron={false} />
        )}
        {site.projectPath ? (
          <>
            <Divider />
            <Row icon="git-branch-outline" title="Project" subtitle={basename(site.projectPath)} chevron={false} />
          </>
        ) : null}
        {site.certExpiresAt ? (
          <>
            <Divider />
            <Row icon="lock-closed-outline" title="Certificate" subtitle={`Valid until ${new Date(site.certExpiresAt).toLocaleDateString()} · renews automatically`} chevron={false} />
          </>
        ) : null}
        <Divider />
        <Row
          icon="code-slash-outline"
          title={config === null ? 'Show nginx config' : 'Hide nginx config'}
          subtitle={site.name}
          onPress={async () => {
            if (config !== null) return setConfig(null);
            try {
              setConfig((await client!.call('sites.config', { name })).text);
            } catch (err) {
              Alert.alert('Couldn\'t read the config', errorMessage(err));
            }
          }}
        />
      </Section>

      {config !== null ? (
        <ScrollView horizontal style={{ backgroundColor: c.codeBg, borderRadius: radius.md }} contentContainerStyle={{ padding: space.md }}>
          <T mono size="xs" selectable>
            {config}
          </T>
        </ScrollView>
      ) : null}

      {site.managed && !site.protected ? (
        <Section footer="Removes the nginx site and certificate. Project files are never deleted.">
          <Row icon="trash-outline" title="Remove website" danger chevron={false} onPress={remove} />
        </Section>
      ) : !site.protected ? (
        <T size="sm" tone="faint">
          This site wasn&apos;t created by niCode, so it can only be switched on or off here.
        </T>
      ) : null}
    </Screen>
  );
}
