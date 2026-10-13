import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AnimatedSplash } from '@/components/AnimatedSplash';
import { useNotificationRouting } from '@/lib/push';
import { applyAppearance, useColors, useIsDark } from '@/theme';

applyAppearance();

export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';

/** Opens the "Share to niCode" screen when another app shares text, a link or images. */
function ShareRouter() {
  const { hasShareIntent } = useShareIntentContext();
  useEffect(() => {
    if (hasShareIntent) router.push('/share');
  }, [hasShareIntent]);
  return null;
}

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <RootStack />
    </ShareIntentProvider>
  );
}

function RootStack() {
  const c = useColors();
  const dark = useIsDark();
  useNotificationRouting();
  const navTheme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: { ...(dark ? DarkTheme : DefaultTheme).colors, background: c.bg, card: c.bg, text: c.text, border: c.border, primary: c.accent },
  };
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.bg }}>
      <SafeAreaProvider>
        <KeyboardProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.bg },
              headerTintColor: c.text,
              headerShadowVisible: false,
              headerBackButtonDisplayMode: 'minimal',
              contentStyle: { backgroundColor: c.bg },
            }}
          >
            <Stack.Screen name="index" options={{ title: 'niCode' }} />
            <Stack.Screen name="pair/scan" options={{ title: 'Scan pairing code', presentation: 'modal' }} />
            <Stack.Screen name="pair/manual" options={{ title: 'Enter pairing code' }} />
            <Stack.Screen name="pair/confirm" options={{ title: 'Pair this phone' }} />
            <Stack.Screen name="settings" options={{ title: 'App settings' }} />
            <Stack.Screen name="share" options={{ title: 'Share to niCode', presentation: 'modal' }} />
            <Stack.Screen name="host/[hostId]/index" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/server" options={{ title: 'Server' }} />
            <Stack.Screen name="host/[hostId]/claude-login" options={{ title: 'Log in to Claude' }} />
            <Stack.Screen name="host/[hostId]/claude-accounts" options={{ title: 'Claude accounts' }} />
            <Stack.Screen name="host/[hostId]/github-login" options={{ title: 'Connect GitHub' }} />
            <Stack.Screen name="host/[hostId]/project/[projectKey]" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/file" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/diff" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/sessions" options={{ title: 'Chats', presentation: 'modal' }} />
            <Stack.Screen name="host/[hostId]/new-project" options={{ title: 'New project', presentation: 'modal' }} />
            <Stack.Screen name="host/[hostId]/sites" options={{ title: 'Websites & domains' }} />
            <Stack.Screen name="host/[hostId]/site" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/add-domain" options={{ title: 'Add a domain' }} />
            <Stack.Screen name="host/[hostId]/apps" options={{ title: 'Apps' }} />
            <Stack.Screen name="host/[hostId]/app" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/app-setup" options={{ title: 'Run as an app' }} />
            <Stack.Screen name="host/[hostId]/preview" options={{ title: 'Preview' }} />
            <Stack.Screen name="host/[hostId]/logs" options={{ title: 'Logs' }} />
            <Stack.Screen name="host/[hostId]/log" options={{ title: '' }} />
          </Stack>
        </ThemeProvider>
        </KeyboardProvider>
        <ShareRouter />
        <AnimatedSplash />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
