import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Banner, Button, Card, Screen, T } from '@/components/ui';
import { useConnection } from '@/lib/connections';
import { errorMessage } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

/** GitHub device-flow login for the server's `gh` CLI (clone private repos, push). */
export default function GithubLogin() {
  const c = useColors();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { client } = useConnection(hostId);
  const [flow, setFlow] = useState<{ loginId: string; userCode: string; verificationUrl: string } | null>(null);
  const [state, setState] = useState<'idle' | 'waiting' | 'done'>('idle');
  const [login, setLogin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await client!.call('setup.github.start', {}, 45_000);
      setFlow(f);
      setState('waiting');
      poll.current = setInterval(async () => {
        try {
          const r = await client!.call('setup.github.poll', { loginId: f.loginId });
          if (r.state === 'pending') return;
          if (poll.current) clearInterval(poll.current);
          if (r.state === 'done') {
            setLogin(r.login ?? null);
            setState('done');
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            void client?.call('server.info', {}).then((info) => (client.info = info));
          } else {
            setState('idle');
            setError(r.error ?? 'GitHub login failed');
          }
        } catch (err) {
          if (poll.current) clearInterval(poll.current);
          setState('idle');
          setError(errorMessage(err));
        }
      }, 3000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (state === 'done') {
    return (
      <Screen>
        <Banner tone="success" icon="logo-github" title={`Connected${login ? ` as ${login}` : ''}`} body="The server can now clone your private repositories and push commits." />
        <Button title="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <T tone="dim">Lets the server clone your repositories and push commits. Uses GitHub&apos;s device login, so you never type your password here.</T>
      {flow ? (
        <Card style={{ alignItems: 'center', gap: space.md }}>
          <T size="sm" tone="dim">
            Enter this code on GitHub
          </T>
          <View style={{ backgroundColor: c.codeBg, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: space.md }}>
            <T mono size="xxl" weight="700" selectable style={{ letterSpacing: 4 }}>
              {flow.userCode}
            </T>
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button small kind="secondary" title="Copy" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(flow.userCode)} />
            <Button small title="Open GitHub" icon="open-outline" onPress={() => void WebBrowser.openBrowserAsync(flow.verificationUrl)} />
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            <ActivityIndicator color={c.accent} />
            <T size="sm" tone="dim">
              Waiting for you to approve on GitHub…
            </T>
          </View>
        </Card>
      ) : (
        <Button title="Get a GitHub code" icon="logo-github" loading={busy} onPress={start} />
      )}
      {error ? <Banner tone="danger" icon="alert-circle-outline" title="GitHub login didn't work" body={error} action={<Button small title="Try again" onPress={start} />} /> : null}
    </Screen>
  );
}
