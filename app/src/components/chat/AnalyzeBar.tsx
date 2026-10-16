import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AnalyzeDb, ServerInfo } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { useOnConnected } from '@/lib/connections';
import { radius, space, useColors } from '@/theme';
import { Icon, T } from '../ui';

/**
 * Shown above an Analyze chat: read-only, how it is enforced (kernel sandbox or soft), and the
 * read-only database. Tapping opens the project's Analyze database settings.
 */
export function AnalyzeBar({ client, info, hostId, projectPath }: { client: NicodeClient | null; info: ServerInfo | null; hostId: string; projectPath: string }) {
  const c = useColors();
  const [db, setDb] = useState<AnalyzeDb | null | undefined>(undefined);
  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('analyze.db.get', { projectPath })
        .then(setDb)
        .catch(() => setDb(null));
    }, [client, projectPath]),
  );
  const kernel = info?.analyzeIsolation === 'kernel';
  const blocked = info?.analyzeBlocked;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Analyze settings"
      onPress={() => router.push({ pathname: '/host/[hostId]/analyze-db', params: { hostId, project: projectPath } })}
      style={({ pressed }) => [styles.bar, { backgroundColor: pressed ? c.surfacePressed : blocked ? c.dangerSoft : c.accentSoft }]}
    >
      <Icon name={blocked ? 'alert-circle-outline' : 'search-outline'} size={16} color={blocked ? c.danger : c.accent} />
      <View style={{ flex: 1 }}>
        <T size="xs" weight="600">
          {blocked ? "Analyze can't run on this server" : `Analyze · read-only${kernel ? ' (sandboxed)' : ''}`}
        </T>
        <T size="xs" tone="dim" numberOfLines={2}>
          {blocked
            ? blocked
            : `${kernel ? 'The project and its git repo are mounted read-only for Claude.' : 'Edits and git writes are blocked; commands still ask you.'} ${
                db === undefined ? '' : db ? `DB: ${db.user}@${db.database} (read-only)` : 'No read-only database set up. Tap to add one.'
              }`}
        </T>
      </View>
      <Icon name="chevron-forward" size={14} color={c.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.md, marginTop: space.sm, padding: space.sm, borderRadius: radius.md },
});
