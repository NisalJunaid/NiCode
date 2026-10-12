import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useIsFocused } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { parsePairingUri } from '@protocol';
import { radius, space, useColors } from '@/theme';
import { Button, EmptyState, Screen, T } from '@/components/ui';

export default function ScanPairing() {
  const c = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const focused = useIsFocused();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  if (!permission) return <Screen>{null}</Screen>;
  if (!permission.granted) {
    return (
      <Screen>
        <EmptyState
          icon="camera-outline"
          title="Camera access needed"
          body="niCode only uses the camera to read your server's pairing QR code."
          action={
            <View style={{ gap: space.sm, alignSelf: 'stretch' }}>
              <Button title="Allow camera" onPress={requestPermission} />
              <Button title="Enter code manually instead" kind="ghost" onPress={() => router.replace('/pair/manual')} />
            </View>
          }
        />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {focused ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            const info = parsePairingUri(data);
            if (!info) {
              setError('That QR code isn\'t a niCode pairing code.');
              return;
            }
            handled.current = true;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            router.replace({ pathname: '/pair/confirm', params: { host: info.host, port: String(info.port), scheme: info.scheme, code: info.code, name: info.name } });
          }}
        />
      ) : null}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.frame, { borderColor: c.accent }]} />
        <View style={[styles.hint, { backgroundColor: c.overlay }]}>
          <T weight="600" style={{ color: '#fff', textAlign: 'center' }}>
            Point at the QR code from your server
          </T>
          <T size="sm" style={{ color: '#ddd', textAlign: 'center' }}>
            {error ?? 'Run `nicode pair` on the server if you need a new one.'}
          </T>
        </View>
        <Button title="Enter code manually" kind="secondary" onPress={() => router.replace('/pair/manual')} style={{ marginBottom: space.xxl }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'space-between', paddingTop: '22%', paddingHorizontal: space.xl },
  frame: { width: 240, height: 240, borderWidth: 3, borderRadius: radius.xl },
  hint: { padding: space.lg, borderRadius: radius.lg, gap: space.xs, marginTop: space.xl },
});
