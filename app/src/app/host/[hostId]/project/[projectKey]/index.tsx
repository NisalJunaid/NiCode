import { router, useGlobalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { TabKeyboardAvoidingView } from '@/components/TabKeyboardAvoidingView';
import type { ClaudeSessionSummary, PermissionMode } from '@protocol';
import { Composer } from '@/components/chat/Composer';
import { Markdown } from '@/components/chat/Markdown';
import { PermissionCard } from '@/components/chat/PermissionCard';
import { ToolCard } from '@/components/chat/ToolCard';
import { ConnectionBar } from '@/components/ConnectionBar';
import { Banner, Button, Icon, T } from '@/components/ui';
import { type ChatItem, buildChatItems } from '@/lib/chatItems';
import { useProject } from '@/lib/project';
import { useConnection, useOnConnected } from '@/lib/connections';
import { errorMessage, formatDuration, relativeTime } from '@/lib/util';
import { useChat, useSessionSync } from '@/state/chat';
import { useSettings } from '@/state/settings';
import { radius, space, useColors } from '@/theme';

/** Which chat is open, per project (in memory; defaults to the most recent one). */
const openSession = new Map<string, string | null>();

export default function ChatScreen() {
  const c = useColors();
  const { hostId, projectPath } = useProject();
  const { session: sessionParam } = useGlobalSearchParams<{ session?: string }>();
  const memoKey = `${hostId}:${projectPath}`;
  const { client, state, info, error } = useConnection(hostId);
  const settings = useSettings();
  const [sessionId, setSessionId] = useState<string | null>(sessionParam === 'new' ? null : (sessionParam ?? openSession.get(memoKey) ?? null));
  const [summaries, setSummaries] = useState<ClaudeSessionSummary[] | null>(null);
  const [draftMode, setDraftMode] = useState<PermissionMode>(settings.defaultMode);
  const [draftModel, setDraftModel] = useState(settings.defaultModel);
  const [sendError, setSendError] = useState<string | null>(null);

  const [seenParam, setSeenParam] = useState(sessionParam);
  if (sessionParam !== seenParam) {
    setSeenParam(sessionParam);
    if (sessionParam) setSessionId(sessionParam === 'new' ? null : sessionParam);
  }
  useEffect(() => {
    openSession.set(memoKey, sessionId);
  }, [memoKey, sessionId]);

  // Recent chats for this project (pick the latest when nothing is open yet).
  const loadSummaries = useCallback(async () => {
    if (!client) return;
    const list = await client.call('claude.list', { projectPath }).catch(() => null);
    if (!list) return;
    setSummaries(list);
    useChat.getState().setSummaries(memoKey, list);
    if (!openSession.has(memoKey) && list[0]) setSessionId((cur) => cur ?? list[0]!.sessionId);
  }, [client, projectPath, memoKey]);
  useOnConnected(client, loadSummaries);

  const data = useSessionSync(client, hostId, sessionId);
  const pending = useChat((s) => s.permissions[hostId]) ?? [];
  const myPending = pending.filter((p) => p.sessionId === sessionId);
  const summary = summaries?.find((s) => s.sessionId === sessionId);
  const mode = summary?.permissionMode ?? draftMode;
  const model = summary?.model && ['opus', 'sonnet', 'haiku'].includes(summary.model) ? summary.model : sessionId ? '' : draftModel;
  const running = data.state === 'running' || data.state === 'awaiting_permission';
  const items = useMemo(() => buildChatItems(data.events), [data.events]);
  const reversed = useMemo(() => [...items].reverse(), [items]);
  const turnStart = useMemo(() => [...data.events].reverse().find((e) => e.event.type === 'nicode' && e.event.subtype === 'user_turn')?.ts, [data.events]);

  const send = async (text: string): Promise<boolean> => {
    if (!client) return false;
    setSendError(null);
    try {
      if (!sessionId) {
        const s = await client.call('claude.start', { projectPath, prompt: text, permissionMode: mode, ...(model ? { model } : {}) });
        setSessionId(s.sessionId);
        void loadSummaries();
      } else {
        await client.call('claude.send', { sessionId, text });
      }
      return true;
    } catch (err) {
      setSendError(errorMessage(err));
      return false;
    }
  };

  const changeMode = (m: PermissionMode) => {
    if (!sessionId || !client) return setDraftMode(m);
    void client.call('claude.setMode', { sessionId, permissionMode: m }).then(loadSummaries).catch((e) => setSendError(errorMessage(e)));
  };
  const changeModel = (m: string) => {
    if (!sessionId || !client) return setDraftModel(m);
    void client.call('claude.setMode', { sessionId, model: m }).then(loadSummaries).catch((e) => setSendError(errorMessage(e)));
  };

  const needsLogin = info && !info.setup.claude;

  return (
    <TabKeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }}>
      <ConnectionBar client={client} state={state} error={error} />
      {needsLogin ? (
        <View style={{ padding: space.lg }}>
          <Banner
            tone="warning"
            icon="key-outline"
            title="Log in to Claude first"
            action={<Button small title="Log in" onPress={() => router.push({ pathname: '/host/[hostId]/claude-login', params: { hostId } })} />}
          />
        </View>
      ) : null}

      {sessionId ? (
        !data.loaded && state === 'open' ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={c.accent} />
          </View>
        ) : (
          <FlatList
            inverted
            data={reversed}
            keyExtractor={(i) => i.key}
            renderItem={({ item, index }) => <ChatRow item={item} pending={running && index < 6} />}
            contentContainerStyle={{ padding: space.md, gap: space.sm }}
            ListHeaderComponent={running ? <Working started={turnStart} /> : null}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          />
        )
      ) : (
        <NewChat summaries={summaries} onOpen={setSessionId} onSuggest={(t) => void send(t)} disabled={state !== 'open' || !!needsLogin} />
      )}

      {data.state === 'error' && data.error ? (
        <View style={{ paddingHorizontal: space.md }}>
          <Banner tone="danger" icon="alert-circle-outline" title="Claude stopped" body={data.error} />
        </View>
      ) : null}
      {sendError ? (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}>
          <Banner tone="danger" icon="alert-circle-outline" title="Couldn't send" body={sendError} />
        </View>
      ) : null}
      {client && myPending[0] ? <PermissionCard hostId={hostId} client={client} req={myPending[0]} queued={myPending.length} /> : null}

      <Composer
        running={running}
        disabled={state !== 'open' || !!needsLogin}
        mode={mode}
        model={model}
        modes={info?.permissionModes ?? ['default', 'acceptEdits', 'plan']}
        placeholder={sessionId ? undefined : 'What should Claude do in this project?'}
        onSend={send}
        onStop={() => sessionId && client?.call('claude.interrupt', { sessionId }).catch(() => undefined)}
        onChangeMode={changeMode}
        onChangeModel={changeModel}
      />
    </TabKeyboardAvoidingView>
  );
}

function ChatRow({ item, pending }: { item: ChatItem; pending: boolean }) {
  const c = useColors();
  switch (item.kind) {
    case 'user':
      return (
        <View style={[styles.user, { backgroundColor: c.userBubble }]}>
          <T selectable>{item.text}</T>
        </View>
      );
    case 'text':
      return (
        <View style={{ paddingHorizontal: space.xs }}>
          <Markdown text={item.text} />
        </View>
      );
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'tool':
      return <ToolCard name={item.name} input={item.input} result={item.result} pending={pending} />;
    case 'result':
      return (
        <View style={styles.meta}>
          <Icon name={item.ok ? 'checkmark-done' : 'alert-circle-outline'} size={14} color={item.ok ? c.success : c.danger} />
          <T size="xs" tone="dim">
            {item.ok ? 'Done' : 'Stopped with an error'}
            {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ''}
          </T>
          {item.text ? (
            <T size="xs" tone="danger" numberOfLines={2} style={{ flex: 1 }}>
              {item.text}
            </T>
          ) : null}
        </View>
      );
    case 'notice':
      return (
        <View style={styles.meta}>
          <Icon name={item.tone === 'danger' ? 'warning-outline' : 'information-circle-outline'} size={14} color={item.tone === 'danger' ? c.danger : c.textDim} />
          <T size="xs" tone={item.tone === 'danger' ? 'danger' : 'dim'} style={{ flex: 1 }}>
            {item.text}
          </T>
        </View>
      );
    case 'init':
      return item.model ? (
        <T size="xs" tone="faint" style={{ textAlign: 'center' }}>
          {item.model}
        </T>
      ) : null;
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" style={{ paddingHorizontal: space.xs, gap: 4 }}>
      <T size="sm" tone="faint" style={{ fontStyle: 'italic' }}>
        {open ? '▾' : '▸'} Thinking
      </T>
      {open ? (
        <T size="sm" tone="dim" selectable>
          {text}
        </T>
      ) : null}
    </Pressable>
  );
}

function Working({ started }: { started?: string }) {
  const c = useColors();
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = started && now ? Math.max(0, Math.round((now - Date.parse(started)) / 1000)) : 0;
  return (
    <View style={[styles.meta, { paddingVertical: space.sm }]}>
      <ActivityIndicator size="small" color={c.accent} />
      <T size="sm" tone="dim">
        Claude is working{secs > 2 ? ` · ${formatDuration(secs * 1000)}` : '…'}
      </T>
    </View>
  );
}

/** Empty state for a project: suggestions + recent chats. */
const SUGGESTIONS = [
  { icon: 'book-outline' as const, text: 'Explain this project', prompt: "Give me a short tour of this project: what it does, how it is structured, and how to run it. Don't change anything." },
  { icon: 'bug-outline' as const, text: 'Find bugs', prompt: "Look through this project for likely bugs or risky code. List the most important ones with file and line, and suggest fixes. Don't change anything yet." },
  { icon: 'flask-outline' as const, text: 'Run the tests', prompt: "Run this project's tests (or its build if there are no tests) and summarise the results. Fix nothing yet." },
  { icon: 'checkmark-done-outline' as const, text: 'Review my changes', prompt: 'Review the uncommitted changes in this repo (git diff) like a careful code reviewer. Point out problems and suggest improvements.' },
];

function NewChat({ summaries, onOpen, onSuggest, disabled }: { summaries: ClaudeSessionSummary[] | null; onOpen: (id: string) => void; onSuggest: (prompt: string) => void; disabled: boolean }) {
  const c = useColors();
  return (
    <FlatList
      data={summaries?.slice(0, 5) ?? []}
      keyExtractor={(s) => s.sessionId}
      contentContainerStyle={{ padding: space.lg, gap: space.sm }}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: space.sm, paddingVertical: space.xl, alignItems: 'center' }}>
          <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="sparkles" size={26} color={c.accent} />
          </View>
          <T size="lg" weight="700">
            New chat with Claude
          </T>
          <T tone="dim" style={{ textAlign: 'center' }}>
            Describe what you want: a fix, a feature, a question about the code. Claude works on the server and asks before anything risky.
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center', marginTop: space.md }}>
            {SUGGESTIONS.map((s) => (
              <Pressable
                key={s.text}
                accessibilityRole="button"
                disabled={disabled}
                onPress={() => onSuggest(s.prompt)}
                style={({ pressed }) => [styles.suggestion, { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: c.border, opacity: disabled ? 0.5 : 1 }]}
              >
                <Icon name={s.icon} size={16} color={c.accent} />
                <T size="sm" weight="500">
                  {s.text}
                </T>
              </Pressable>
            ))}
          </View>
          {summaries && summaries.length > 0 ? (
            <T size="sm" weight="600" tone="dim" style={{ alignSelf: 'flex-start', marginTop: space.lg }}>
              Recent chats
            </T>
          ) : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onOpen(item.sessionId)}
          style={({ pressed }) => [styles.recent, { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: c.border }]}
        >
          <Icon name="chatbubble-ellipses-outline" size={18} color={c.textDim} />
          <View style={{ flex: 1 }}>
            <T numberOfLines={1} weight="500">
              {item.title}
            </T>
            <T size="xs" tone="dim">
              {relativeTime(item.updatedAt)}
            </T>
          </View>
          {item.state === 'running' || item.state === 'awaiting_permission' ? <ActivityIndicator size="small" color={c.accent} /> : null}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  user: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.md, paddingVertical: space.sm },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.xs },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 40 },
  recent: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
});
