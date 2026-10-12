import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import type { ClaudeSessionSummary } from '@protocol';
import { MODE_INFO } from '@/components/chat/Composer';
import { Button, Divider, EmptyState, Loading, Row } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { pathKey, relativeTime } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

/** All chats in a project, newest first, plus "New chat". */
export default function Sessions() {
  const c = useColors();
  const { hostId, project } = useLocalSearchParams<{ hostId: string; project: string }>();
  const { client } = useConnection(hostId);
  const [list, setList] = useState<ClaudeSessionSummary[] | null>(null);

  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('claude.list', { projectPath: project })
        .then(setList)
        .catch(() => setList([]));
    }, [client, project]),
  );

  const open = (session: string) => {
    router.back();
    router.navigate({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(project), session } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: space.lg }}>
        <Button title="New chat" icon="add" onPress={() => open('new')} />
      </View>
      {list === null ? (
        <Loading />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(s) => s.sessionId}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}
          ItemSeparatorComponent={Divider}
          ListEmptyComponent={<EmptyState icon="chatbubbles-outline" title="No chats yet" body="Start one and it shows up here." />}
          renderItem={({ item, index }) => (
            <View
              style={{
                backgroundColor: c.surface,
                borderTopLeftRadius: index === 0 ? radius.lg : 0,
                borderTopRightRadius: index === 0 ? radius.lg : 0,
                borderBottomLeftRadius: index === list.length - 1 ? radius.lg : 0,
                borderBottomRightRadius: index === list.length - 1 ? radius.lg : 0,
                overflow: 'hidden',
              }}
            >
              <Row
                icon="chatbubble-ellipses-outline"
                title={item.title || 'Untitled chat'}
                subtitle={`${relativeTime(item.updatedAt)} · ${MODE_INFO[item.permissionMode]?.label ?? item.permissionMode}`}
                right={item.state === 'running' || item.state === 'awaiting_permission' ? <ActivityIndicator size="small" color={c.accent} /> : undefined}
                onPress={() => open(item.sessionId)}
              />
            </View>
          )}
        />
      )}
    </View>
  );
}
