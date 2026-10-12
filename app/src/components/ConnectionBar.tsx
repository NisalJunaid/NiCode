import { router } from 'expo-router';
import { View } from 'react-native';
import type { ConnState, NicodeClient } from '@/lib/client';
import { space } from '@/theme';
import { Banner, Button } from './ui';

export function connStatus(state: ConnState): { dot: 'ok' | 'busy' | 'off' | 'bad'; label: string } {
  switch (state) {
    case 'open':
      return { dot: 'ok', label: 'Connected' };
    case 'connecting':
    case 'reconnecting':
      return { dot: 'busy', label: 'Connecting…' };
    case 'unlocking':
      return { dot: 'busy', label: 'Waiting for fingerprint…' };
    case 'locked':
      return { dot: 'off', label: 'Locked — tap to unlock' };
    case 'unpaired':
      return { dot: 'bad', label: 'Not paired anymore' };
    case 'offline':
      return { dot: 'bad', label: 'Server unreachable' };
    default:
      return { dot: 'off', label: 'Not connected' };
  }
}

/**
 * Shown at the top of server screens whenever the connection isn't healthy, with the one action
 * that fixes it (unlock, retry, or pair again).
 */
export function ConnectionBar({ client, state, error }: { client: NicodeClient | null; state: ConnState; error: string | null }) {
  if (!client || state === 'open' || state === 'idle') return null;
  let body: React.ReactNode = null;
  if (state === 'locked') {
    body = (
      <Banner
        tone="accent"
        icon="finger-print"
        title="Unlock to connect"
        body="Confirm it's you to sign in to this server."
        action={<Button small title="Unlock" icon="lock-open-outline" onPress={() => client.reconnectNow()} />}
      />
    );
  } else if (state === 'unpaired') {
    body = (
      <Banner
        tone="danger"
        icon="unlink-outline"
        title="This phone isn't paired anymore"
        body={error ?? 'The server removed this phone. Run `nicode pair` on the server and scan the new code.'}
        action={<Button small title="Pair again" icon="qr-code-outline" onPress={() => router.push('/pair/scan')} />}
      />
    );
  } else if (state === 'offline') {
    body = (
      <Banner
        tone="warning"
        icon="cloud-offline-outline"
        title="Can't reach the server"
        body={error ? `${error}. Retrying automatically.` : 'Retrying automatically.'}
        action={<Button small kind="secondary" title="Retry now" onPress={() => client.reconnectNow()} />}
      />
    );
  } else {
    body = <Banner tone="accent" icon="sync-outline" title={connStatus(state).label} />;
  }
  return <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>{body}</View>;
}
