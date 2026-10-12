import { Stack, Tabs, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { connStatus } from '@/components/ConnectionBar';
import { Icon, IconButton, StatusDot, T } from '@/components/ui';
import { useConnection } from '@/lib/connections';
import { basename, keyPath } from '@/lib/util';
import { ProjectContext } from '@/lib/project';
import { usePermissionSync } from '@/state/chat';
import { useColors } from '@/theme';

export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';

/** A project = four tabs: Chat (Claude), Files, Changes (git), Terminal. */
export default function ProjectLayout() {
  const c = useColors();
  const { hostId, projectKey } = useLocalSearchParams<{ hostId: string; projectKey: string }>();
  const projectPath = keyPath(projectKey);
  const { client, state } = useConnection(hostId);
  const pending = usePermissionSync(client, hostId);
  const s = connStatus(state);

  return (
    <ProjectContext.Provider value={{ hostId, projectPath }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: 'center' }}>
              <T weight="700" numberOfLines={1}>
                {basename(projectPath)}
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <StatusDot tone={s.dot} />
                <T size="xs" tone="dim">
                  {s.label}
                </T>
              </View>
            </View>
          ),
          headerRight: () => (
            <IconButton
              icon="chatbubbles-outline"
              label="All chats in this project"
              onPress={() => router.push({ pathname: '/host/[hostId]/sessions', params: { hostId, project: projectPath } })}
            />
          ),
        }}
      />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: c.accent,
          tabBarInactiveTintColor: c.textDim,
          tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
          // Keep the tab bar fixed: hiding it while the keyboard opens breaks keyboard avoidance.
          tabBarHideOnKeyboard: false,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          sceneStyle: { backgroundColor: c.bg },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Chat',
            tabBarIcon: ({ color }) => <Icon name="sparkles-outline" color={color} size={22} />,
            tabBarBadge: pending.length ? pending.length : undefined,
            tabBarBadgeStyle: { backgroundColor: c.warning, color: c.onAccent, fontSize: 10 },
          }}
        />
        <Tabs.Screen name="files" options={{ title: 'Files', tabBarIcon: ({ color }) => <Icon name="folder-outline" color={color} size={22} /> }} />
        <Tabs.Screen name="changes" options={{ title: 'Changes', tabBarIcon: ({ color }) => <Icon name="git-compare-outline" color={color} size={22} /> }} />
        <Tabs.Screen name="terminal" options={{ title: 'Terminal', tabBarIcon: ({ color }) => <Icon name="terminal-outline" color={color} size={22} /> }} />
      </Tabs>
    </ProjectContext.Provider>
  );
}
