import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { baseUrl, type PairResponse } from '@protocol';
import { getClient } from '@/lib/connections';
import { confirmOwner, deviceIdFor, ensureKey, KeyLockedError } from '@/lib/deviceKey';
import { errorMessage, randomId } from '@/lib/util';
import { useHosts } from '@/state/hosts';
import { space, useColors } from '@/theme';
import { Banner, Button, Card, Field, Icon, Screen, T } from '@/components/ui';

export default function ConfirmPairing() {
  const c = useColors();
  const p = useLocalSearchParams<{ host: string; port: string; scheme: 'https' | 'http'; code: string; name: string }>();
  const [deviceName, setDeviceName] = useState(Device.deviceName ?? Device.modelName ?? 'My phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addHost = useHosts((s) => s.add);
  const target = { host: p.host, port: Number(p.port), scheme: p.scheme === 'http' ? ('http' as const) : ('https' as const) };

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      const { alg, publicKey } = await ensureKey();
      // Confirm it's really the owner before registering this phone with a server.
      await confirmOwner(`Pair with ${p.name}`);
      const res = await fetch(`${baseUrl(target)}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: p.code, deviceName: deviceName.trim() || 'My phone', alg, publicKey }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<PairResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Pairing failed (${res.status})`);
      const expected = await deviceIdFor(publicKey);
      const hostId = randomId();
      addHost({
        id: hostId,
        name: body.hostname ?? p.name,
        ...target,
        deviceId: body.deviceId ?? expected,
        addedAt: new Date().toISOString(),
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      getClient(hostId);
      router.dismissTo('/');
      router.push({ pathname: '/host/[hostId]', params: { hostId } });
    } catch (err) {
      setError(err instanceof KeyLockedError ? 'Pairing needs your fingerprint or face to confirm it\'s you.' : errorMessage(err));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="server-outline" color={c.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <T size="lg" weight="600">
                {p.name}
              </T>
              <T size="sm" tone="dim">
                {p.host}
              </T>
            </View>
          </View>
        </Card>
        <Field label="Name for this phone" value={deviceName} onChangeText={setDeviceName} hint="Shown in the server's device list, so you can remove it later." />
        <Banner
          tone="accent"
          icon="shield-checkmark-outline"
          title="No password is shared"
          body="This phone creates its own key, protected by your fingerprint or face. The server only receives the public half."
        />
        {target.scheme === 'http' ? (
          <Banner
            tone="warning"
            icon="lock-open-outline"
            title="Not encrypted"
            body="This server uses plain http (local mode). Only use it on your own network. Logins stay safe, but code and chats travel unencrypted."
          />
        ) : null}
        {error ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't pair" body={error} /> : null}
        <Button title="Pair with fingerprint" icon="finger-print" loading={busy} onPress={pair} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
