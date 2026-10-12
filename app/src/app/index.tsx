import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import { FlatList, View } from 'react-native';
import { useConnection } from '@/lib/connections';
import type { Host } from '@/state/hosts';
import { useHosts } from '@/state/hosts';
import { space, useColors } from '@/theme';
import { Badge, Button, Card, Icon, IconButton, Screen, StatusDot, T } from '@/components/ui';
import { connStatus } from '@/components/ConnectionBar';
import { Logo } from '@/components/Logo';

const INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/NisalJunaid/NiCode/main/dist/nicode-install.sh -o nicode-install.sh && sudo bash nicode-install.sh';

export default function Home() {
  const hosts = useHosts((s) => s.hosts);
  return (
    <>
      <Stack.Screen
        options={{
          title: 'niCode',
          headerTitle: () => <HeaderLogo />,
          headerRight: () => <IconButton icon="settings-outline" label="App settings" onPress={() => router.push('/settings')} />,
        }}
      />
      {hosts.length === 0 ? <Welcome /> : <HostList hosts={hosts} />}
    </>
  );
}

function HostList({ hosts }: { hosts: Host[] }) {
  return (
    <FlatList
      data={hosts}
      keyExtractor={(h) => h.id}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
      ListHeaderComponent={
        <T size="sm" tone="dim" style={{ marginBottom: space.xs }}>
          Your servers
        </T>
      }
      renderItem={({ item }) => <HostCard host={item} />}
      ListFooterComponent={
        <View style={{ marginTop: space.md }}>
          <Button title="Add a server" icon="add" kind="secondary" onPress={() => router.push('/pair/scan')} />
        </View>
      }
    />
  );
}

function HostCard({ host }: { host: Host }) {
  const c = useColors();
  const { state, info } = useConnection(host.id);
  const s = connStatus(state);
  return (
    <Card onPress={() => router.push({ pathname: '/host/[hostId]', params: { hostId: host.id } })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="server-outline" color={c.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T size="lg" weight="600" numberOfLines={1}>
            {host.name}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <StatusDot tone={s.dot} />
            <T size="sm" tone="dim" numberOfLines={1}>
              {s.label}
            </T>
          </View>
        </View>
        <Icon name="chevron-forward" size={18} color={c.textFaint} />
      </View>
      {info && !info.setup.claude ? <Badge text="Claude login needed" tone="warning" /> : null}
    </Card>
  );
}

function HeaderLogo() {
  const c = useColors();
  return <Logo width={96} color={c.text} tagline={false} />;
}

function Welcome() {
  const c = useColors();
  return (
    <Screen scroll>
      <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
        <Logo width={220} color={c.text} tagColor={c.textDim} />
        <T size="xxl" weight="700" style={{ textAlign: 'center', marginTop: space.md }}>
          Code with Claude, from anywhere
        </T>
        <T tone="dim" style={{ textAlign: 'center' }}>
          niCode connects this phone to your own server, where Claude Code works on your projects.
        </T>
      </View>

      <Card>
        <Step n={1} title="Install niCode on your server" />
        <T size="sm" tone="dim">
          Run this once on your Ubuntu server (as root). It detects everything itself and doesn&apos;t touch your existing sites.
        </T>
        <View style={{ backgroundColor: c.codeBg, borderRadius: 10, padding: space.md }}>
          <T mono size="xs" selectable>
            {INSTALL_CMD}
          </T>
        </View>
        <Button title="Copy command" icon="copy-outline" kind="secondary" small onPress={() => void Clipboard.setStringAsync(INSTALL_CMD)} />
      </Card>

      <Card>
        <Step n={2} title="Pair this phone" />
        <T size="sm" tone="dim">
          The installer ends with a QR code. If it has expired, run <T size="sm" mono>nicode pair</T> on the server to get a new one.
        </T>
        <Button title="Scan QR code" icon="qr-code-outline" onPress={() => router.push('/pair/scan')} />
        <Button title="Enter code manually" kind="ghost" onPress={() => router.push('/pair/manual')} />
      </Card>
    </Screen>
  );
}

function Step({ n, title }: { n: number; title: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
        <T size="xs" weight="700" style={{ color: c.onAccent }}>
          {n}
        </T>
      </View>
      <T weight="600">{title}</T>
    </View>
  );
}
