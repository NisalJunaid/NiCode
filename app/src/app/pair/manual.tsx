import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { parsePairingUri } from '@protocol';
import { Button, Field, Screen, T } from '@/components/ui';

/** Host + one-time code typed by hand (or a pasted nicode://pair link). */
export default function ManualPairing() {
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    setError(null);
    const pasted = parsePairingUri(host.trim());
    if (pasted) {
      router.replace({ pathname: '/pair/confirm', params: { host: pasted.host, port: String(pasted.port), scheme: pasted.scheme, code: pasted.code, name: pasted.name } });
      return;
    }
    const m = /^(?:(https?):\/\/)?([^/:\s]+)(?::(\d+))?\/?$/.exec(host.trim());
    if (!m) return setError('Enter the server address, e.g. 203-0-113-7.sslip.io');
    if (code.replace(/[^0-9a-z]/gi, '').length < 8) return setError('Enter the 10-character code shown by `nicode pair`.');
    const scheme = (m[1] as 'http' | 'https' | undefined) ?? 'https';
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 7878;
    router.replace({ pathname: '/pair/confirm', params: { host: m[2]!, port: String(port), scheme, code: code.trim(), name: m[2]! } });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll>
        <T tone="dim">On your server, run <T mono>nicode pair</T>. It shows the address and a one-time code that works for 10 minutes.</T>
        <Field
          label="Server address"
          placeholder="203-0-113-7.sslip.io"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={host}
          onChangeText={setHost}
          hint="You can also paste the whole nicode://pair link here."
        />
        <Field
          label="Pairing code"
          placeholder="XXXXX-XXXXX"
          autoCapitalize="characters"
          autoCorrect={false}
          value={code}
          onChangeText={setCode}
          onSubmitEditing={go}
          returnKeyType="go"
        />
        {error ? <T tone="danger">{error}</T> : null}
        <Button title="Continue" onPress={go} disabled={!host.trim()} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
