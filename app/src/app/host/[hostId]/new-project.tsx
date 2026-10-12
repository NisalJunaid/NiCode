import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, View } from 'react-native';
import { StarterForm } from '@/components/StarterForm';
import { Banner, Button, Divider, EmptyState, Field, Loading, Row, Screen, Segmented, T } from '@/components/ui';
import { buildPrompt } from '@/lib/starters';
import { useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage, pathKey, relativeTime } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

type Mode = 'starter' | 'github' | 'url';
interface Repo {
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  updatedAt: string;
}

export default function NewProject() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { client, info } = useConnection(hostId);
  const [mode, setMode] = useState<Mode>('starter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (path: string, session?: string) => {
    router.back();
    router.push({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(path), ...(session ? { session } : {}) } });
  };

  const run = async (fn: () => Promise<{ path: string }>) => {
    setBusy(true);
    setError(null);
    try {
      open((await fn()).path);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen padded={false}>
      <View style={{ padding: space.lg, gap: space.md }}>
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'starter', label: 'New app' },
            { value: 'github', label: 'My GitHub' },
            { value: 'url', label: 'Git URL' },
          ]}
        />
        {error ? <Banner tone="danger" icon="alert-circle-outline" title="That didn't work" body={error} /> : null}
      </View>
      {mode === 'starter' ? (
        <StarterForm
          busy={busy}
          claudeReady={!!info?.setup.claude}
          onCreate={async (choice) => {
            setBusy(true);
            setError(null);
            try {
              const project = await client!.call('projects.create', { name: choice.name, gitInit: true });
              if (choice.stack.id === 'blank' || !info?.setup.claude) return open(project.path);
              const session = await client!.call('claude.start', {
                projectPath: project.path,
                prompt: buildPrompt(choice),
                permissionMode: info.permissionModes.includes('acceptEdits') ? 'acceptEdits' : 'default',
              });
              open(project.path, session.sessionId);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : mode === 'github' ? (
        info?.setup.github ? (
          <GithubRepos hostId={hostId} busy={busy} onPick={(r) => run(() => client!.call('projects.clone', { url: r.nameWithOwner }, 10 * 60_000))} />
        ) : (
          <EmptyState
            icon="logo-github"
            title="Connect GitHub first"
            body="Then your repositories show up here, including private ones."
            action={<Button title="Connect GitHub" onPress={() => router.push({ pathname: '/host/[hostId]/github-login', params: { hostId } })} />}
          />
        )
      ) : mode === 'url' ? (
        <CloneUrl busy={busy} onClone={(url, name) => run(() => client!.call('projects.clone', { url, ...(name ? { name } : {}) }, 10 * 60_000))} />
      ) : null}
    </Screen>
  );
}

function GithubRepos({ hostId, busy, onPick }: { hostId: string; busy: boolean; onPick: (r: Repo) => void }) {
  const c = useColors();
  const { client } = useConnection(hostId);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('projects.githubRepos', { limit: 300 }, 60_000)
        .then(setRepos)
        .catch((e) => setErr(errorMessage(e)));
    }, [client]),
  );
  if (err) return <EmptyState icon="alert-circle-outline" title="Couldn't list repositories" body={err} />;
  if (!repos) return <Loading label="Loading your repositories…" />;
  const list = repos.filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q.toLowerCase()));
  return (
    <FlatList
      data={list}
      keyExtractor={(r) => r.nameWithOwner}
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}
      ListHeaderComponent={<Field placeholder="Search repositories" value={q} onChangeText={setQ} autoCapitalize="none" style={{ marginBottom: space.md }} />}
      ItemSeparatorComponent={Divider}
      renderItem={({ item }) => (
        <View style={{ backgroundColor: c.surface, borderRadius: radius.md, overflow: 'hidden' }}>
          <Row
            icon={item.isPrivate ? 'lock-closed-outline' : 'logo-github'}
            title={item.nameWithOwner}
            subtitle={`updated ${relativeTime(item.updatedAt)}`}
            onPress={busy ? undefined : () => onPick(item)}
            right={busy ? <T size="sm" tone="dim">Cloning…</T> : <T size="sm" tone="accent">Clone</T>}
            chevron={false}
          />
        </View>
      )}
    />
  );
}

function CloneUrl({ busy, onClone }: { busy: boolean; onClone: (url: string, name: string) => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  return (
    <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
      <Field label="Repository" placeholder="https://github.com/me/app.git or me/app" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="Folder name (optional)" placeholder="taken from the repo" value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} />
      <Button title={busy ? 'Cloning…' : 'Clone'} icon="download-outline" loading={busy} disabled={!url.trim()} onPress={() => onClone(url.trim(), name.trim())} />
    </View>
  );
}
