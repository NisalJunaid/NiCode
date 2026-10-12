import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Alert, Switch, View } from 'react-native';
import { MODE_INFO } from '@/components/chat/Composer';
import { Divider, Row, Screen, Section, T } from '@/components/ui';
import { resetKey } from '@/lib/deviceKey';
import { useHosts } from '@/state/hosts';
import { useSettings } from '@/state/settings';
import { useColors } from '@/theme';

export default function AppSettings() {
  const c = useColors();
  const s = useSettings();
  const hosts = useHosts((x) => x.hosts);

  return (
    <Screen scroll>
      <Section title="Security" footer={s.graceSeconds === 0 ? 'Every connection asks for your fingerprint or face.' : 'After unlocking, reconnects within 5 minutes don\'t ask again.'}>
        <Row
          icon="finger-print"
          title="Ask every time"
          subtitle="Require fingerprint/face for every connection"
          chevron={false}
          right={
            <Switch
              value={s.graceSeconds === 0}
              onValueChange={(v) => s.set({ graceSeconds: v ? 0 : 300 })}
              trackColor={{ true: c.accent, false: c.surface2 }}
              thumbColor="#fff"
            />
          }
        />
      </Section>

      <Section title="New chats" footer="You can change this per chat from the composer.">
        {(['default', 'acceptEdits', 'plan'] as const).map((m, i) => (
          <View key={m}>
            {i > 0 ? <Divider /> : null}
            <Row
              icon={MODE_INFO[m].icon}
              title={MODE_INFO[m].label}
              subtitle={MODE_INFO[m].desc}
              chevron={false}
              onPress={() => s.set({ defaultMode: m })}
              right={s.defaultMode === m ? <T tone="accent">✓</T> : undefined}
            />
          </View>
        ))}
      </Section>

      <Section title="This phone" footer="Resetting the key logs this phone out of every server; you'll need to pair them again.">
        <Row
          icon="key-outline"
          title="Reset this phone's key"
          danger
          chevron={false}
          onPress={() =>
            Alert.alert('Reset key?', `You'll need to pair ${hosts.length} server(s) again with \`nicode pair\`.`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Reset',
                style: 'destructive',
                onPress: async () => {
                  await resetKey();
                  useHosts.setState({ hosts: [] });
                  router.dismissTo('/');
                },
              },
            ])
          }
        />
      </Section>

      <T size="sm" tone="faint" style={{ textAlign: 'center' }}>
        niCode {Constants.expoConfig?.version ?? ''}
      </T>
    </Screen>
  );
}
