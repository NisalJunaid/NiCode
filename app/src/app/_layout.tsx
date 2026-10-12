import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useNotificationRouting } from '@/lib/push';
import { useColors, useIsDark } from '@/theme';

export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';

export default function RootLayout() {
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
            <Stack.Screen name="host/[hostId]/index" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/server" options={{ title: 'Server' }} />
            <Stack.Screen name="host/[hostId]/claude-login" options={{ title: 'Log in to Claude' }} />
            <Stack.Screen name="host/[hostId]/github-login" options={{ title: 'Connect GitHub' }} />
            <Stack.Screen name="host/[hostId]/project/[projectKey]" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/file" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/diff" options={{ title: '' }} />
            <Stack.Screen name="host/[hostId]/sessions" options={{ title: 'Chats', presentation: 'modal' }} />
            <Stack.Screen name="host/[hostId]/new-project" options={{ title: 'New project', presentation: 'modal' }} />
          </Stack>
        </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
