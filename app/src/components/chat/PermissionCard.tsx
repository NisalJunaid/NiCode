import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PermissionRequest } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { toolSummary } from '@/lib/chatItems';
import { errorMessage } from '@/lib/util';
import { useChat } from '@/state/chat';
import { radius, space, useColors } from '@/theme';
import { DiffView, editToLines } from '../Diff';
import { Button, Field, type IconName, Icon, T } from '../ui';

/**
 * "Claude wants to …" — pinned above the composer until answered. Big, unambiguous buttons;
 * "Always" explains exactly what will be remembered.
 */
export function PermissionCard({ hostId, client, req, queued }: { hostId: string; client: NicodeClient; req: PermissionRequest; queued: number }) {
  const c = useColors();
  const [busy, setBusy] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const s = toolSummary(req.toolName, req.input);

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [req.requestId]);

  const cmd = typeof req.input.command === 'string' ? req.input.command : '';
  const alwaysLabel = req.toolName === 'Bash' ? (cmd && !/[;&|`$<>]/.test(cmd) ? `Always allow "${cmd.split(/\s+/)[0]}"` : null) : `Always allow ${s.title}`;

  const respond = async (behavior: 'allow' | 'deny', remember = false) => {
    setBusy(behavior + (remember ? '+' : ''));
    setError(null);
    try {
      await client.call('claude.permission.respond', { requestId: req.requestId, behavior, remember, ...(behavior === 'deny' && reason.trim() ? { message: reason.trim() } : {}) });
      useChat.getState().removePermission(hostId, req.requestId);
      void Haptics.selectionAsync();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.warning }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Icon name={s.icon as IconName} size={18} color={c.warning} />
        <T weight="700" style={{ flex: 1 }}>
          Claude wants to {req.toolName === 'Bash' ? 'run a command' : s.title.toLowerCase()}
        </T>
        {queued > 1 ? <T size="xs" tone="dim">1 of {queued}</T> : null}
      </View>
      {req.toolName === 'Bash' ? (
        <View style={{ backgroundColor: c.codeBg, borderRadius: radius.sm, padding: space.sm }}>
          <T mono size="sm" selectable numberOfLines={6}>
            $ {cmd}
          </T>
        </View>
      ) : (req.toolName === 'Edit' || req.toolName === 'MultiEdit') && typeof req.input.old_string === 'string' ? (
        <>
          <T size="sm" tone="dim" mono numberOfLines={1} ellipsizeMode="head">
            {s.detail}
          </T>
          <DiffView lines={editToLines(req.input.old_string, String(req.input.new_string ?? ''))} maxLines={6} numbers={false} />
        </>
      ) : (
        <T size="sm" tone="dim" mono numberOfLines={3}>
          {s.detail || JSON.stringify(req.input)}
        </T>
      )}

      {denying ? (
        <>
          <Field placeholder="Tell Claude why or what to do instead (optional)" value={reason} onChangeText={setReason} autoFocus />
          <View style={styles.buttons}>
            <Button small kind="secondary" title="Back" onPress={() => setDenying(false)} style={{ flex: 1 }} />
            <Button small kind="danger" title="Deny" loading={busy === 'deny'} onPress={() => respond('deny')} style={{ flex: 1 }} />
          </View>
        </>
      ) : (
        <>
          <View style={styles.buttons}>
            <Button kind="secondary" title="Deny" icon="close" onPress={() => setDenying(true)} style={{ flex: 1 }} />
            <Button title="Allow" icon="checkmark" loading={busy === 'allow'} onPress={() => respond('allow')} style={{ flex: 1 }} />
          </View>
          {alwaysLabel ? <Button small kind="ghost" title={alwaysLabel} loading={busy === 'allow+'} onPress={() => respond('allow', true)} /> : null}
        </>
      )}
      {error ? (
        <T size="sm" tone="danger">
          {error}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: radius.lg, padding: space.md, gap: space.sm, marginHorizontal: space.md, marginBottom: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
});
