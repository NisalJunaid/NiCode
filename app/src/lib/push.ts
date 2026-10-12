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
import { useSettings } from '@/state/settings';
import { getClient } from './connections';
import type { NicodeClient } from './client';
import { pathKey } from './util';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let tokenPromise: Promise<string | null> | null = null;

const projectId = () => (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;

/** False when this build has no push credentials (EAS project id + FCM); see docs/04. */
export function pushConfigured(): boolean {
  return !!projectId();
}

async function getPushToken(): Promise<string | null> {
  const id = projectId();
  if (!id || !Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('agent', { name: 'Claude finished', importance: Notifications.AndroidImportance.DEFAULT });
    await Notifications.setNotificationChannelAsync('approvals', { name: 'Approvals needed', importance: Notifications.AndroidImportance.HIGH });
    await Notifications.setNotificationChannelAsync('alerts', { name: 'App crashes & sites down', importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch {
    return null; // no FCM credentials in this build
  }
}

/** Registers this phone with a server for push (once per connection). */
export async function registerPush(client: NicodeClient): Promise<void> {
  tokenPromise ??= getPushToken();
  const token = await tokenPromise;
  if (!token) return;
  await client.call('push.register', { expoPushToken: token, platform: Platform.OS === 'ios' ? 'ios' : 'android', prefs: useSettings.getState().notify }).catch(() => undefined);
}

/** Re-sends this phone's preferences to every connected server. */
export function reRegisterPush(): void {
  for (const h of useHosts.getState().hosts) {
    const c = getClient(h.id);
    if (c?.state === 'open') void registerPush(c);
  }
}

/** Whether this phone got a push token (asks for permission the first time). */
export async function pushReady(): Promise<boolean> {
  tokenPromise ??= getPushToken();
  return !!(await tokenPromise);
}

/** Tapping a notification opens the right chat (and its pending approval). */
export function useNotificationRouting(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as { kind?: string; sessionId?: string; projectPath?: string; host?: string; name?: string } | undefined;
      if (!data) return;
      // The daemon doesn't know our host id; match by the server's public host if possible.
      const host = useHosts.getState().hosts.find((h) => !data.host || h.host === data.host) ?? useHosts.getState().hosts[0];
      if (!host) return;
      if (data.kind === 'app' && data.name) return router.push({ pathname: '/host/[hostId]/app', params: { hostId: host.id, name: data.name } });
      if (data.kind === 'site' && data.name) return router.push({ pathname: '/host/[hostId]/site', params: { hostId: host.id, name: data.name } });
      if (!data.sessionId || !data.projectPath) return;
      router.push({
        pathname: '/host/[hostId]/project/[projectKey]',
        params: { hostId: host.id, projectKey: pathKey(data.projectPath), session: data.sessionId },
      });
    });
    return () => sub.remove();
  }, []);
}
