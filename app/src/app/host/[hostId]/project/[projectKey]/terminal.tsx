import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { TabKeyboardAvoidingView } from '@/components/TabKeyboardAvoidingView';
import { ConnectionBar } from '@/components/ConnectionBar';
import { type TerminalHandle, TerminalView } from '@/components/TerminalView';
import { Banner, Button, T } from '@/components/ui';
import { useProject } from '@/lib/project';
import { useConnection, useOnConnected } from '@/lib/connections';
import { basename, errorMessage } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

/** Keys phones don't have. Sequences are sent straight to the shell. */
const KEYS: { label: string; seq?: string; ctrl?: true }[] = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: 'ctrl', ctrl: true },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: 'home', seq: '\x1b[H' },
  { label: 'end', seq: '\x1b[F' },
];

export default function TerminalTab() {
  const c = useColors();
  const { hostId, projectPath } = useProject();
  const { client, state, error } = useConnection(hostId);
  const term = useRef<TerminalHandle>(null);
  const size = useRef<{ cols: number; rows: number } | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState(false);

  const open = useCallback(async () => {
    if (!client || !size.current || client.state !== 'open') return;
    setOpenError(null);
    try {
      const info = await client.call('term.open', { cwd: projectPath, name: basename(projectPath), ...size.current });
      const a = await client.call('term.attach', { termId: info.termId, ...size.current });
      term.current?.clear();
      if (a.replay) term.current?.write(a.replay);
      setTermId(info.termId);
      setEnded(false);
      term.current?.focus();
    } catch (err) {
      setOpenError(errorMessage(err));
    }
  }, [client, projectPath]);

  // Re-attach after every reconnect (tmux kept the session alive on the server).
  useOnConnected(client, open);

  useEffect(() => {
    if (!client || !termId) return;
    const a = client.on('term.data', (d) => d.termId === termId && term.current?.write(d.data));
    const b = client.on('term.exit', (d) => d.termId === termId && setEnded(true));
    return () => {
      a();
      b();
    };
  }, [client, termId]);

  const sendInput = (b64: string) => termId && client?.send('term.write', { termId, data: b64 });

  return (
    <TabKeyboardAvoidingView style={{ flex: 1, backgroundColor: c.codeBg }}>
      <ConnectionBar client={client} state={state} error={error} />
      {openError ? (
        <View style={{ padding: space.md }}>
          <Banner tone="danger" icon="alert-circle-outline" title="Couldn't open a terminal" body={openError} action={<Button small title="Retry" onPress={open} />} />
        </View>
      ) : null}
      {ended ? (
        <View style={{ padding: space.md }}>
          <Banner tone="accent" icon="power-outline" title="Terminal session ended" action={<Button small title="Start a new one" onPress={open} />} />
        </View>
      ) : null}
      <TerminalView
        ref={term}
        onReady={(cols, rows) => {
          size.current = { cols, rows };
          void open();
        }}
        onResize={(cols, rows) => {
          size.current = { cols, rows };
          if (termId) client?.send('term.resize', { termId, cols, rows });
        }}
        onInput={sendInput}
        onCtrlUsed={() => setCtrl(false)}
      />
      <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border }]}>
        <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: space.sm }}>
          {KEYS.map((k) => {
            const active = k.ctrl && ctrl;
            return (
              <Pressable
                key={k.label}
                accessibilityRole="button"
                accessibilityLabel={k.label}
                onPress={() => {
                  if (k.ctrl) {
                    const next = !ctrl;
                    setCtrl(next);
                    term.current?.setCtrl(next);
                  } else if (k.seq) {
                    term.current?.sendKey(k.seq);
                  }
                }}
                style={({ pressed }) => [styles.key, { backgroundColor: active ? c.accent : pressed ? c.surfacePressed : c.surface2 }]}
              >
                <T size="sm" weight="600" mono style={{ color: active ? c.onAccent : c.text }}>
                  {k.label}
                </T>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </TabKeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  key: { minWidth: 44, height: 38, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
});
