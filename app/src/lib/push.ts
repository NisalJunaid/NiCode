/**
 * Push notifications: "Claude finished" and "Claude needs approval".
 * Registration needs an EAS project id (and FCM credentials on Android); without them the app
 * silently skips push and everything else works.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useHosts } from '@/state/hosts';
import type { NicodeClient } from './client';
import { pathKey } from './util';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let tokenPromise: Promise<string | null> | null = null;

async function getPushToken(): Promise<string | null> {
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId || !Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('agent', { name: 'Claude finished', importance: Notifications.AndroidImportance.DEFAULT });
    await Notifications.setNotificationChannelAsync('approvals', { name: 'Approvals needed', importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null; // no FCM credentials in this build
  }
}

/** Registers this phone with a server for push (once per connection). */
export async function registerPush(client: NicodeClient): Promise<void> {
  tokenPromise ??= getPushToken();
  const token = await tokenPromise;
  if (!token) return;
  await client.call('push.register', { expoPushToken: token, platform: Platform.OS === 'ios' ? 'ios' : 'android' }).catch(() => undefined);
}

/** Tapping a notification opens the right chat (and its pending approval). */
export function useNotificationRouting(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as { sessionId?: string; projectPath?: string; host?: string } | undefined;
      if (!data?.sessionId || !data.projectPath) return;
      // The daemon doesn't know our host id; match by the server's public host if possible.
      const host = useHosts.getState().hosts.find((h) => !data.host || h.host === data.host) ?? useHosts.getState().hosts[0];
      if (!host) return;
      router.push({
        pathname: '/host/[hostId]/project/[projectKey]',
        params: { hostId: host.id, projectKey: pathKey(data.projectPath), session: data.sessionId },
      });
    });
    return () => sub.remove();
  }, []);
}
