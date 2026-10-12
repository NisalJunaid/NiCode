import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import type { DeviceInfo } from '@protocol';
import { ConnectionBar, connStatus } from '@/components/ConnectionBar';
import { Badge, Divider, Row, Screen, Section, StatusDot, T } from '@/components/ui';
import { dropClient, useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage, relativeTime } from '@/lib/util';
import { useHost, useHosts } from '@/state/hosts';
import { space } from '@/theme';

type Dev = DeviceInfo & { current: boolean };

export default function ServerSettings() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const host = useHost(hostId);
  const removeHost = useHosts((s) => s.remove);
  const { client, state, info, error } = useConnection(hostId);
  const [devices, setDevices] = useState<Dev[] | null>(null);

  const loadDevices = useCallback(() => {
    client?.call('auth.devices', {}).then(setDevices).catch(() => undefined);
  }, [client]);
  useOnConnected(client, loadDevices);

  const deviceActions = (d: Dev) => {
    Alert.alert(d.name, d.kind === 'key' ? 'Phone' : `Browser token${d.expiresAt ? `, expires ${relativeTime(d.expiresAt)}` : ''}`, [
      {
        text: d.current ? 'Unpair this phone' : 'Remove access',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Remove access?', `${d.name} will be disconnected immediately and must pair again.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: async () => {
                try {
                  await client?.call('auth.revoke', { id: d.id });
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  if (d.current) {
                    dropClient(hostId);
                    removeHost(hostId);
                    router.dismissTo('/');
                  } else loadDevices();
                } catch (err) {
                  Alert.alert('Couldn\'t remove', errorMessage(err));
                }
              },
            },
          ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const forget = () =>
    Alert.alert('Remove this server from the app?', 'The server keeps working. To also revoke this phone\'s access, use "Unpair this phone" in the device list instead.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          dropClient(hostId);
          removeHost(hostId);
          router.dismissTo('/');
        },
      },
    ]);

  if (!host) return null;
  const s = connStatus(state);
  return (
    <Screen scroll padded={false}>
      <ConnectionBar client={client} state={state} error={error} />
      <View style={{ padding: space.lg, gap: space.xl }}>
        <Section title="Server">
          <Row title={host.name} subtitle={host.host} icon="server-outline" right={<StatusDot tone={s.dot} />} chevron={false} />
          <Divider />
          <Row title="Status" subtitle={s.label} icon="pulse-outline" chevron={false} />
          {info ? (
            <>
              <Divider />
              <Row title="Runs as" subtitle={`${info.user} · projects in ${info.projectsRoot}`} icon="person-outline" chevron={false} />
              <Divider />
              <Row title="Versions" subtitle={`niCode ${info.daemonVersion} · ${info.claudeVersion ?? 'Claude not found'}`} icon="information-circle-outline" chevron={false} />
            </>
          ) : null}
        </Section>

        <Section title="Accounts on the server" footer="These logins live on the server; your phone never stores them.">
          <Row
            title="Claude"
            icon="sparkles-outline"
            subtitle={info ? (info.setup.claude ? 'Logged in with your subscription' : 'Not logged in') : '—'}
            right={info ? <Badge text={info.setup.claude ? 'Ready' : 'Log in'} tone={info.setup.claude ? 'success' : 'warning'} /> : null}
            onPress={info && !info.setup.claude ? () => router.push({ pathname: '/host/[hostId]/claude-login', params: { hostId } }) : undefined}
          />
          <Divider />
          <Row
            title="GitHub"
            icon="logo-github"
            subtitle={info ? (info.setup.github ? 'Connected (clone & push)' : 'Not connected') : '—'}
            right={info ? <Badge text={info.setup.github ? 'Connected' : 'Connect'} tone={info.setup.github ? 'success' : 'default'} /> : null}
            onPress={info && !info.setup.github ? () => router.push({ pathname: '/host/[hostId]/github-login', params: { hostId } }) : undefined}
          />
        </Section>

        <Section title="Websites" footer="nginx sites on this server: domains, HTTPS, on/off.">
          <Row icon="globe-outline" title="Websites & domains" subtitle="Add a domain to a project in one tap" onPress={() => router.push({ pathname: '/host/[hostId]/sites', params: { hostId } })} />
        </Section>

        <Section title="Devices with access" footer="Tap a device to remove it. On the server: nicode token list.">
          {devices === null ? (
            <Row title="Loading…" chevron={false} />
          ) : (
            devices.map((d, i) => (
              <View key={d.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  icon={d.kind === 'key' ? 'phone-portrait-outline' : 'globe-outline'}
                  title={d.name + (d.current ? ' (this phone)' : '')}
                  subtitle={d.kind === 'key' ? `Paired ${relativeTime(d.createdAt)}` : `Browser token · expires ${relativeTime(d.expiresAt)}`}
                  onPress={() => deviceActions(d)}
                />
              </View>
            ))
          )}
        </Section>

        <Section>
          <Row title="Remove server from this app" icon="trash-outline" danger onPress={forget} chevron={false} />
        </Section>
        <T size="sm" tone="faint" style={{ textAlign: 'center' }}>
          Device id {host.deviceId}
        </T>
      </View>
    </Screen>
  );
}
