import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import type { AccountUsage, ClaudeAccount } from '@protocol';
import { UsageBars } from '@/components/UsageBars';
import { Banner, Button, Field, Icon, IconButton, Loading, T } from '@/components/ui';
import { useConnection, useOnConnected, useServerEvent } from '@/lib/connections';
import { errorMessage, relativeTime } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

/**
 * The Claude subscriptions logged in on this server: tap one to switch, rename it, log it out,
 * or add another. The tokens stay on the server.
 */
export default function ClaudeAccounts() {
  const c = useColors();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { client } = useConnection(hostId);
  const [accounts, setAccounts] = useState<ClaudeAccount[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [usage, setUsage] = useState<Record<string, AccountUsage>>({});

  const refreshInfo = () =>
    client
      ?.call('server.info', {})
      .then((i) => (client.info = i))
      .catch(() => undefined);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setAccounts((await client.call('setup.claudeAccounts.list', {})).accounts);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setAccounts([]);
    }
    // Usage: checked against Claude at most once a minute per account (the server limits it).
    client
      .call('setup.claudeAccounts.usage', { refresh: true }, 30_000)
      .then((r) => setUsage(r.usage))
      .catch(() => undefined);
  }, [client]);
  useServerEvent(client, 'claude.usage', (e) => setUsage((u) => ({ ...u, [e.accountId]: e.usage })));
  useOnConnected(client, load);
  // Coming back from "Add another account" shows the new one.
  useFocusEffect(
    useCallback(() => {
      if (client?.state === 'open') void load();
    }, [client, load]),
  );

  const run = async (id: string, fn: () => Promise<ClaudeAccount[]>) => {
    setBusy(id);
    setError(null);
    try {
      setAccounts(await fn());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void refreshInfo();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const switchTo = (a: ClaudeAccount) => {
    if (a.active || busy) return;
    void run(a.id, async () => (await client!.call('setup.claudeAccounts.switch', { id: a.id })).accounts);
  };

  const logout = (a: ClaudeAccount) =>
    Alert.alert(
      `Log out of ${a.label}?`,
      a.active ? 'The server forgets this login. Your most recently used other account takes over (if any).' : 'The server forgets this login.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: () => void run(a.id, async () => (await client!.call('setup.claudeAccounts.logout', { id: a.id })).accounts),
        },
      ],
    );

  const actions = (a: ClaudeAccount) =>
    a.kind === 'cli'
      ? Alert.alert(
          a.label,
          'This login was made on the server itself. It is used whenever none of your niCode accounts is active. To sign it out, run `claude /logout` on the server.',
        )
      : Alert.alert(a.label, a.hint ? `Token ${a.hint}` : undefined, [
          ...(a.active ? [] : [{ text: 'Use this account', onPress: () => switchTo(a) }]),
          { text: 'Rename', onPress: () => setRenaming({ id: a.id, label: a.label }) },
          { text: 'Log out', style: 'destructive' as const, onPress: () => logout(a) },
          { text: 'Cancel', style: 'cancel' as const },
        ]);

  if (!accounts) return <Loading />;
  const active = accounts.find((a) => a.active);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
      keyboardShouldPersistTaps="handled"
    >
      <T tone="dim">
        {active
          ? `Claude on this server uses ${active.label}. Tap another account to switch; chats continue with it from their next message.`
          : 'No Claude account is active on this server. Add one to start coding.'}
      </T>

      {accounts.map((a) => (
        <View key={a.id}>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: a.active }}
            accessibilityLabel={`${a.label}${a.active ? ', in use' : ''}`}
            onPress={() => switchTo(a)}
            onLongPress={() => actions(a)}
            style={({ pressed }) => [
              styles.card,
              { backgroundColor: pressed ? c.surfacePressed : a.active ? c.accentSoft : c.surface, borderColor: a.active ? c.accent : c.border },
            ]}
          >
            <View style={styles.head}>
              <Icon name={a.active ? 'radio-button-on' : 'radio-button-off'} size={22} color={a.active ? c.accent : c.textFaint} />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="700">{a.label}</T>
                <T size="sm" tone="dim">
                  {a.kind === 'cli'
                    ? 'Logged in on the server itself'
                    : [a.hint, a.active ? 'in use' : a.lastUsedAt ? `used ${relativeTime(a.lastUsedAt)}` : a.addedAt ? `added ${relativeTime(a.addedAt)}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                </T>
              </View>
              {busy === a.id ? <ActivityIndicator color={c.accent} /> : <IconButton icon="ellipsis-horizontal" label={`Options for ${a.label}`} onPress={() => actions(a)} />}
            </View>
            <View style={{ paddingLeft: 22 + space.md }}>
              <UsageBars usage={usage[a.id]} />
            </View>
          </Pressable>
          {renaming?.id === a.id ? (
            <View style={[styles.rename, { borderColor: c.border, backgroundColor: c.surface }]}>
              <Field label="Name" value={renaming.label} onChangeText={(label) => setRenaming({ ...renaming, label })} autoFocus maxLength={40} placeholder="Personal, Work…" />
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button small kind="ghost" title="Cancel" onPress={() => setRenaming(null)} style={{ flex: 1 }} />
                <Button
                  small
                  title="Save"
                  disabled={!renaming.label.trim()}
                  onPress={() => {
                    const r = renaming;
                    setRenaming(null);
                    void run(r.id, async () => (await client!.call('setup.claudeAccounts.rename', { id: r.id, label: r.label.trim() })).accounts);
                  }}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}
        </View>
      ))}

      {error ? <Banner tone="danger" icon="alert-circle-outline" title="That didn't work" body={error} /> : null}

      <Button
        title={accounts.length ? 'Add another Claude account' : 'Log in to Claude'}
        icon="add"
        onPress={() => router.push({ pathname: '/host/[hostId]/claude-login', params: { hostId, add: '1' } })}
      />
      <T size="xs" tone="faint" style={{ textAlign: 'center' }}>
        Each account is a Claude Pro or Max subscription. Long-press an account to rename or log out.
      </T>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md, borderWidth: 1, borderRadius: radius.lg, padding: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rename: { marginTop: space.sm, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md },
});
