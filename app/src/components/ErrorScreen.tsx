import type { ErrorBoundaryProps } from 'expo-router';
import { router } from 'expo-router';
import { View } from 'react-native';
import { space, useColors } from '@/theme';
import { Button, EmptyState, T } from './ui';

/** Shown instead of closing the app when a screen crashes. */
export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: space.lg }}>
      <EmptyState
        icon="bug-outline"
        title="Something went wrong on this screen"
        body="Your servers and chats are safe. Try again, or go back."
        action={
          <View style={{ gap: space.sm, alignSelf: 'stretch' }}>
            <Button title="Try again" icon="refresh" onPress={retry} />
            <Button title="Go back" kind="secondary" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
          </View>
        }
      />
      <T size="xs" tone="faint" mono selectable style={{ textAlign: 'center' }}>
        {error.message}
      </T>
    </View>
  );
}
