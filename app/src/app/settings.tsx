import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Alert, Switch, View } from 'react-native';
import { MODE_INFO } from '@/components/chat/Composer';
import { Logo } from '@/components/Logo';
import { Divider, Row, Screen, Section, Segmented, T } from '@/components/ui';
import { getClient } from '@/lib/connections';
import { resetKey } from '@/lib/deviceKey';
import { pushConfigured, pushReady, reRegisterPush } from '@/lib/push';
import { errorMessage } from '@/lib/util';
import { useHosts } from '@/state/hosts';
import { useSettings } from '@/state/settings';
import { useColors } from '@/theme';

export default function AppSettings() {
  const c = useColors();
  const s = useSettings();
  const hosts = useHosts((x) => x.hosts);

  return (
    <Screen scroll>
      <Section title="Appearance" footer={s.appearance === 'system' ? "Follows your phone's light/dark setting." : undefined}>
        <View style={{ padding: 12 }}>
          <Segmented
            value={s.appearance}
            onChange={(appearance) => s.set({ appearance })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
          />
        </View>
      </Section>

      <Section
        title="Notifications"
        footer={
          pushConfigured()
            ? 'Sent by your servers through Expo push. Open a server once after changing these.'
            : 'This build of the app has no push credentials yet (Expo project + Firebase). See docs/04 → Push setup.'
        }
      >
        {(
          [
            ['approvals', 'hand-left-outline', 'Claude needs approval', 'Approve or deny without the app open'],
            ['finished', 'checkmark-done-outline', 'Claude finished', 'When a chat turn is done'],
            ['appCrashes', 'warning-outline', 'App crashed', 'A pm2 app errored or keeps restarting'],
            ['siteDown', 'globe-outline', 'Site down', 'A website stops answering, and when it is back'],
          ] as const
        ).map(([key, icon, title, subtitle], i) => (
          <View key={key}>
            {i > 0 ? <Divider /> : null}
            <Row
              icon={icon}
              title={title}
              subtitle={subtitle}
              chevron={false}
              right={
                <Switch
                  value={s.notify[key]}
                  disabled={!pushConfigured()}
                  onValueChange={(v) => {
                    s.set({ notify: { ...s.notify, [key]: v } });
                    reRegisterPush();
                  }}
                  trackColor={{ true: c.accent, false: c.surface2 }}
                  thumbColor="#fff"
                />
              }
            />
          </View>
        ))}
        <Divider />
        <Row
          icon="notifications-outline"
          title="Send a test notification"
          chevron={false}
          onPress={async () => {
            if (!pushConfigured()) return Alert.alert("Push isn't set up in this build", 'See docs/04 → Push setup.');
            if (!(await pushReady())) return Alert.alert('Notifications are off', 'Allow notifications for niCode in system settings.');
            const client = hosts.map((h) => getClient(h.id)).find((x) => x?.state === 'open');
            if (!client) return Alert.alert('Connect to a server first', 'Open one of your servers, then try again.');
            try {
              reRegisterPush();
              await client.call('push.test', {});
              Alert.alert('Sent', 'It should arrive in a few seconds.');
            } catch (err) {
              Alert.alert("Couldn't send", errorMessage(err));
            }
          }}
        />
      </Section>

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

      <View style={{ alignItems: 'center', gap: 8, paddingTop: 8 }}>
        <Logo width={150} color={c.text} tagColor={c.textFaint} />
        <T size="sm" tone="faint">
          Version {Constants.expoConfig?.version ?? ''}
        </T>
      </View>
    </Screen>
  );
}
