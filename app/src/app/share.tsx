import { Image } from 'expo-image';
import { router, Stack } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import type { ClaudeSessionSummary, Project } from '@protocol';
import { Banner, Button, EmptyState, Icon, Segmented, T } from '@/components/ui';
import { type Attachment, MAX_IMAGES, prepareImage, rememberSent } from '@/lib/attachments';
import { useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage, pathKey, relativeTime } from '@/lib/util';
import { useHosts } from '@/state/hosts';
import { useSettings } from '@/state/settings';
import { font, radius, space, useColors } from '@/theme';

/**
 * Share to niCode: text, a link or screenshots shared from any app become a message to Claude
 * in the project you pick (a new chat, or the latest one).
 */
export default function ShareScreen() {
  const c = useColors();
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const hosts = useHosts((s) => s.hosts);
  const [hostId, setHostId] = useState(hosts[0]?.id ?? '');
  const { client, state } = useConnection(hostId);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [latest, setLatest] = useState<ClaudeSessionSummary | null>(null);
  const [target, setTarget] = useState<'new' | 'latest'>('new');
  const [note, setNote] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shared = useMemo(() => {
    const text = (shareIntent.text ?? '').trim();
    const url = shareIntent.webUrl ?? null;
    return { text, url, files: (shareIntent.files ?? []).filter((f) => f.mimeType?.startsWith('image/')).slice(0, MAX_IMAGES) };
  }, [shareIntent]);

  // Shrink shared images like the composer does.
  useEffect(() => {
    let alive = true;
    void Promise.all(shared.files.map((f) => prepareImage(f.path, f.width ?? undefined, f.height ?? undefined).catch(() => null))).then((out) => {
      if (alive) setImages(out.filter((x): x is Attachment => !!x));
    });
    return () => {
      alive = false;
    };
  }, [shared.files]);

  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('projects.list', {})
        .then((list) => {
          const sorted = [...list].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
          setProjects(sorted);
          setProject((cur) => cur ?? sorted[0]?.path ?? null);
        })
        .catch((e) => setError(errorMessage(e)));
    }, [client]),
  );

  useEffect(() => {
    if (!client || !project || state !== 'open') return;
    client
      .call('claude.list', { projectPath: project })
      .then((list) => setLatest([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null))
      .catch(() => setLatest(null));
  }, [client, project, state]);

  const message = useMemo(() => {
    const parts = [note.trim() || (images.length && !shared.text ? 'Take a look at this.' : 'Look at this:')];
    if (shared.text) parts.push(shared.url && shared.text === shared.url ? shared.url : `> ${shared.text.replace(/\n/g, '\n> ')}`);
    return parts.join('\n\n');
  }, [note, shared, images.length]);

  const cancel = () => {
    resetShareIntent();
    router.replace('/');
  };

  const send = async () => {
    if (!client || !project) return;
    setBusy(true);
    setError(null);
    const imgs = images.length ? { images: images.map((a) => a.image) } : {};
    try {
      let sessionId: string;
      if (target === 'latest' && latest) {
        await client.call('claude.send', { sessionId: latest.sessionId, text: message, ...imgs }, 120_000);
        sessionId = latest.sessionId;
      } else {
        const s = useSettings.getState();
        const r = await client.call('claude.start', { projectPath: project, prompt: message, permissionMode: s.defaultMode, ...(s.defaultModel ? { model: s.defaultModel } : {}), ...imgs }, 120_000);
        sessionId = r.sessionId;
        rememberSent(sessionId, 0, images.map((a) => a.uri));
      }
      resetShareIntent();
      router.replace({ pathname: '/host/[hostId]/project/[projectKey]', params: { hostId, projectKey: pathKey(project), session: sessionId } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!hosts.length) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Stack.Screen options={{ title: 'Share to niCode' }} />
        <EmptyState icon="server-outline" title="No server yet" body="Pair a server first, then share again." action={<Button small title="Close" onPress={cancel} />} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Share to niCode' }} />

      {/* What was shared */}
      <View style={[styles.box, { backgroundColor: c.surface, borderColor: c.border }]}>
        {images.length ? (
          <ScrollView horizontal contentContainerStyle={{ gap: space.sm }}>
            {images.map((a) => (
              <Image key={a.uri} source={{ uri: a.uri }} style={styles.thumb} contentFit="cover" />
            ))}
          </ScrollView>
        ) : null}
        {shared.text ? (
          <T size="sm" numberOfLines={8} selectable>
            {shared.text}
          </T>
        ) : null}
        {!images.length && !shared.text ? (
          <T size="sm" tone="dim">
            Nothing to send (only text, links and images can be shared).
          </T>
        ) : null}
      </View>

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="What should Claude do with it? (optional)"
        placeholderTextColor={c.textFaint}
        multiline
        style={[styles.note, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
      />

      {hosts.length > 1 ? (
        <View style={{ gap: space.sm }}>
          <T size="sm" weight="600" tone="dim">
            Server
          </T>
          <Segmented value={hostId} onChange={(v) => (setHostId(v), setProjects(null), setProject(null))} options={hosts.slice(0, 4).map((h) => ({ value: h.id, label: h.name }))} />
        </View>
      ) : null}

      <View style={{ gap: space.sm }}>
        <T size="sm" weight="600" tone="dim">
          Project
        </T>
        {projects === null ? (
          <T tone="dim">{state === 'open' ? 'Loading projects…' : 'Connecting…'}</T>
        ) : (
          projects.slice(0, 8).map((p) => {
            const on = p.path === project;
            return (
              <Pressable
                key={p.path}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => setProject(p.path)}
                style={[styles.option, { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accentSoft : c.surface }]}
              >
                <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={18} color={on ? c.accent : c.textFaint} />
                <View style={{ flex: 1 }}>
                  <T weight="600">{p.name}</T>
                  {p.lastOpenedAt ? (
                    <T size="xs" tone="dim">
                      used {relativeTime(p.lastOpenedAt)}
                    </T>
                  ) : null}
                </View>
              </Pressable>
            );
          })
        )}
      </View>

      {latest ? (
        <Segmented
          value={target}
          onChange={setTarget}
          options={[
            { value: 'new', label: 'New chat' },
            { value: 'latest', label: `Continue “${latest.title.slice(0, 18)}”` },
          ]}
        />
      ) : null}

      {error ? <Banner tone="danger" icon="alert-circle-outline" title="Couldn't send" body={error} /> : null}
      <Button title="Send to Claude" icon="sparkles-outline" loading={busy} disabled={!project || (!shared.text && !images.length) || state !== 'open'} onPress={() => void send()} />
      <Button title="Cancel" kind="ghost" onPress={cancel} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  thumb: { width: 88, height: 88, borderRadius: radius.md },
  note: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, minHeight: 56, fontSize: font.size.md },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md },
});
