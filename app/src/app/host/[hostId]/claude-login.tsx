import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Banner, Button, Card, Field, Screen, T } from '@/components/ui';
import { useConnection } from '@/lib/connections';
import { errorMessage } from '@/lib/util';
import { space, useColors } from '@/theme';

/**
 * Claude subscription login, driven on the server (`claude setup-token` in a PTY):
 * 1) open the login page, 2) paste the code it shows, 3) the server verifies and saves it.
 */
export default function ClaudeLogin() {
  const c = useColors();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { client } = useConnection(hostId);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'start' | 'code' | 'done'>('start');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [token, setToken] = useState('');

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client!.call('setup.claudeLogin.start', {}, 45_000);
      setLoginId(r.loginId);
      setStep('code');
      await WebBrowser.openBrowserAsync(r.url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setStep('done');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await client?.call('server.info', {}).then((info) => (client.info = info)).catch(() => undefined);
    } catch (err) {
      setError(errorMessage(err));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'done') {
    return (
      <Screen>
        <Banner tone="success" icon="checkmark-circle" title="Claude is ready" body="Your subscription is connected on this server." />
        <Button title="Start coding" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll>
        <T tone="dim">This connects your Claude Pro or Max subscription to the server. You only do it once.</T>
        <Card>
          <StepTitle n={1} title="Open the Claude login page" done={step !== 'start'} />
          <T size="sm" tone="dim">
            Sign in and approve. Claude then shows a code.
          </T>
          <Button title={step === 'start' ? 'Open Claude login' : 'Open it again'} icon="open-outline" kind={step === 'start' ? 'primary' : 'secondary'} loading={busy && step === 'start'} onPress={start} />
        </Card>
        <Card style={{ opacity: step === 'code' ? 1 : 0.5 }}>
          <StepTitle n={2} title="Paste the code here" />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Field placeholder="Code from the Claude page" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} editable={step === 'code'} />
            </View>
            <Button small kind="secondary" title="Paste" icon="clipboard-outline" disabled={step !== 'code'} onPress={async () => setCode((await Clipboard.getStringAsync()).trim())} style={{ alignSelf: 'flex-end', minHeight: 48 }} />
          </View>
          <Button
            title={busy && step === 'code' ? 'Checking with Claude…' : 'Finish login'}
            loading={busy && step === 'code'}
            disabled={step !== 'code' || code.trim().length < 4}
            onPress={() => finish(() => client!.call('setup.claudeLogin.submit', { loginId: loginId!, code: code.trim() }, 120_000))}
          />
        </Card>
        {error ? <Banner tone="danger" icon="alert-circle-outline" title="Login didn't work" body={error} /> : null}

        {manual ? (
          <Card>
            <T weight="600">Paste a token instead</T>
            <T size="sm" tone="dim">
              On any computer with Claude Code, run <T size="sm" mono>claude setup-token</T> and paste the token it prints (starts with sk-ant-oat).
            </T>
            <Field placeholder="sk-ant-oat…" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry />
            <Button title="Use this token" kind="secondary" loading={busy} disabled={!token.startsWith('sk-ant-')} onPress={() => finish(() => client!.call('setup.claudeLogin.setToken', { token: token.trim() }, 120_000))} />
          </Card>
        ) : (
          <Button title="Having trouble? Paste a token instead" kind="ghost" onPress={() => setManual(true)} />
        )}
        <View style={{ height: space.xl, backgroundColor: c.bg }} />
      </Screen>
    </KeyboardAvoidingView>
  );
}

function StepTitle({ n, title, done }: { n: number; title: string; done?: boolean }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: done ? c.success : c.accent, alignItems: 'center', justifyContent: 'center' }}>
        <T size="xs" weight="700" style={{ color: c.onAccent }}>
          {done ? '✓' : n}
        </T>
      </View>
      <T weight="600">{title}</T>
    </View>
  );
}
