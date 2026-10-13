import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountUsage, UsageWindow } from '@protocol';
import { relativeTime } from '@/lib/util';
import { radius, space, useColors } from '@/theme';
import { Icon, T } from './ui';

/** "in 2h 13m" within a day, otherwise "Mon 15:00". */
export function resetText(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resetting now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (ms < 86_400_000) return `resets in ${h ? `${h}h ` : ''}${m}m`;
  const d = new Date(iso);
  return `resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function useTone() {
  const c = useColors();
  return (pct: number) => (pct >= 90 ? c.danger : pct >= 70 ? c.warning : c.accent);
}

function Bar({ label, w }: { label: string; w: UsageWindow | null }) {
  const c = useColors();
  const tone = useTone();
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <T size="sm" weight="600" style={{ flex: 1 }}>
          {label}
        </T>
        {w ? (
          <T size="sm" weight="700" style={{ color: tone(w.usedPercent) }}>
            {Math.round(w.usedPercent)}% used
          </T>
        ) : (
          <T size="sm" tone="faint">
            —
          </T>
        )}
      </View>
      <View style={[styles.track, { backgroundColor: c.surface2 }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: w?.usedPercent ?? 0 }}>
        {w ? <View style={[styles.fill, { width: `${Math.max(2, Math.min(100, w.usedPercent))}%`, backgroundColor: tone(w.usedPercent) }]} /> : null}
      </View>
      <T size="xs" tone="dim">
        {w ? `${Math.max(0, Math.round(100 - w.usedPercent))}% left${w.resetsAt ? ` · ${resetText(w.resetsAt)}` : ''}` : 'Not known yet'}
      </T>
    </View>
  );
}

/** The 5-hour session and weekly usage of one Claude account. */
export function UsageBars({ usage }: { usage: AccountUsage | undefined }) {
  const c = useColors();
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) {
    return (
      <T size="xs" tone="faint">
        {usage?.error ?? 'No usage numbers yet. Pull down to check, or chat with this account.'}
      </T>
    );
  }
  return (
    <View style={{ gap: space.md }}>
      {usage.status === 'rejected' ? (
        <View style={[styles.note, { backgroundColor: c.dangerSoft }]}>
          <Icon name="alert-circle" size={14} color={c.danger} />
          <T size="xs" weight="600" style={{ color: c.danger }}>
            Limit reached
          </T>
        </View>
      ) : null}
      <Bar label="5-hour session" w={usage.fiveHour} />
      <Bar label="Weekly" w={usage.sevenDay} />
      <T size="xs" tone="faint">
        Updated {relativeTime(usage.updatedAt)}
        {usage.source === 'chat' ? ' · from chats' : ''}
        {usage.error && usage.source === 'chat' ? ' · direct check unavailable' : ''}
      </T>
    </View>
  );
}

/** Compact meter for the chat: "5h 42% · wk 18%". */
export function UsagePill({ usage, onPress }: { usage: AccountUsage | null | undefined; onPress: () => void }) {
  const c = useColors();
  const tone = useTone();
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null;
  const worst = Math.max(usage.fiveHour?.usedPercent ?? 0, usage.sevenDay?.usedPercent ?? 0);
  const color = usage.status === 'rejected' ? c.danger : tone(worst);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Claude usage: ${usage.fiveHour ? `${Math.round(usage.fiveHour.usedPercent)} percent of the 5-hour session` : ''}${usage.sevenDay ? `, ${Math.round(usage.sevenDay.usedPercent)} percent of the week` : ''}. Open accounts`}
      onPress={onPress}
      style={[styles.pill, { backgroundColor: c.surface2 }]}
    >
      <Icon name="speedometer-outline" size={13} color={color} />
      <T size="xs" weight="600">
        {usage.fiveHour ? `5h ${Math.round(usage.fiveHour.usedPercent)}%` : ''}
        {usage.fiveHour && usage.sevenDay ? ' · ' : ''}
        {usage.sevenDay ? `wk ${Math.round(usage.sevenDay.usedPercent)}%` : ''}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { height: 8, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, height: 30, borderRadius: radius.pill },
});
