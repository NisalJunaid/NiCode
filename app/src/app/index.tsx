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

type ListRow = { kind: 'header'; key: string; title: string } | { kind: 'host'; key: string; host: Host };

/** Production servers first and set apart, so it's always clear where Claude can change things. */
function HostList({ hosts }: { hosts: Host[] }) {
  const prod = hosts.filter((h) => h.role === 'production');
  const dev = hosts.filter((h) => h.role !== 'production');
  const rows: ListRow[] = prod.length
    ? [
        { kind: 'header', key: 'h-prod', title: 'Production (Claude analyzes only)' },
        ...prod.map((h): ListRow => ({ kind: 'host', key: h.id, host: h })),
        ...(dev.length ? [{ kind: 'header', key: 'h-dev', title: 'Development' } as ListRow] : []),
        ...dev.map((h): ListRow => ({ kind: 'host', key: h.id, host: h })),
      ]
    : [{ kind: 'header', key: 'h-all', title: 'Your servers' }, ...hosts.map((h): ListRow => ({ kind: 'host', key: h.id, host: h }))];
  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <T size="sm" tone="dim" style={{ marginTop: item.key === 'h-dev' ? space.md : 0 }}>
            {item.title}
          </T>
        ) : (
          <HostCard host={item.host} />
        )
      }
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
  const production = (info?.role ?? host.role) === 'production';
  return (
    <Card onPress={() => router.push({ pathname: '/host/[hostId]', params: { hostId: host.id } })} style={production ? { borderLeftWidth: 3, borderLeftColor: c.danger } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: production ? c.dangerSoft : c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={production ? 'shield-checkmark-outline' : 'server-outline'} color={production ? c.danger : c.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <T size="lg" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {host.name}
            </T>
            {production ? <Badge text="PROD" tone="danger" /> : null}
          </View>
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
