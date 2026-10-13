import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { DiffView, parseUnifiedDiff } from '@/components/Diff';
import { Button, EmptyState, Loading, T } from '@/components/ui';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage } from '@/lib/util';
import { space } from '@/theme';

export default function DiffScreen() {
  const { hostId, project, path, staged, base, head, commit } = useLocalSearchParams<{
    hostId: string;
    project: string;
    path: string;
    staged?: string;
    /** A Claude turn's checkpoints (read-only view). */
    base?: string;
    head?: string;
    /** One commit (read-only view). */
    commit?: string;
  }>();
  const readOnly = !!(base || commit);
  const isStaged = staged === '1';
  const { client } = useConnection(hostId);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('git.diff', base ? { projectPath: project, path, base, ...(head ? { head } : {}) } : commit ? { projectPath: project, path, commit } : { projectPath: project, path, staged: isStaged })
        .then((r) => setDiff(r.diff))
        .catch((e) => setError(errorMessage(e)));
    }, [client, project, path, isStaged, base, head, commit]),
  );
  const lines = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);
  const adds = lines.filter((l) => l.type === 'add').length;
  const dels = lines.filter((l) => l.type === 'del').length;

  const toggle = async () => {
    setBusy(true);
    try {
      await client!.call(isStaged ? 'git.unstage' : 'git.stage', { projectPath: project, paths: [path] });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: basename(path),
          headerRight: readOnly ? undefined : () => <Button small kind="secondary" title={isStaged ? 'Unstage' : 'Stage'} loading={busy} onPress={toggle} />,
        }}
      />
      {error ? (
        <EmptyState icon="alert-circle-outline" title="Couldn't load the diff" body={error} />
      ) : diff === null ? (
        <Loading />
      ) : !diff.trim() ? (
        <EmptyState icon="document-outline" title="No text changes" body="Binary file, or only the file mode changed." />
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.md, gap: space.sm }}>
          <T size="sm" tone="dim" mono>
            {path} · <T size="sm" tone="success">+{adds}</T> <T size="sm" tone="danger">−{dels}</T>
          </T>
          <DiffView lines={lines} />
        </ScrollView>
      )}
    </>
  );
}
