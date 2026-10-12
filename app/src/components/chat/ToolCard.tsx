import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { toolSummary } from '@/lib/chatItems';
import { radius, space, useColors } from '@/theme';
import { DiffView, editToLines } from '../Diff';
import { type IconName, Icon, T } from '../ui';

interface Props {
  name: string;
  input: Record<string, unknown>;
  result?: { text: string; isError: boolean };
  /** Still waiting for a result (only true for the newest calls of a running turn). */
  pending: boolean;
}

/** One tool call: compact one-line summary; tap to see the full input and output. */
export const ToolCard = memo(function ToolCard({ name, input, result, pending }: Props) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const s = toolSummary(name, input);
  const isEdit = (name === 'Edit' || name === 'MultiEdit') && (typeof input.old_string === 'string' || Array.isArray(input.edits));
  const statusIcon: IconName | null = result ? (result.isError ? 'close-circle' : 'checkmark-circle') : null;

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: result?.isError ? c.danger : c.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${s.title} ${s.detail}. ${open ? 'Collapse' : 'Expand'}`}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.surfacePressed }]}
      >
        <Icon name={s.icon as IconName} size={16} color={c.textDim} />
        <T size="sm" weight="600">
          {s.title}
        </T>
        <T size="sm" tone="dim" mono numberOfLines={1} style={{ flex: 1 }}>
          {s.detail}
        </T>
        {pending && !result ? <ActivityIndicator size="small" color={c.accent} /> : statusIcon ? <Icon name={statusIcon} size={16} color={result!.isError ? c.danger : c.success} /> : null}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color={c.textFaint} />
      </Pressable>

      {/* Edits are the most useful thing to see at a glance: show a short diff even when collapsed. */}
      {isEdit && !open && typeof input.old_string === 'string' ? (
        <View style={styles.body}>
          <DiffView lines={editToLines(input.old_string, String(input.new_string ?? ''))} maxLines={8} numbers={false} />
        </View>
      ) : null}

      {open ? (
        <View style={[styles.body, { gap: space.sm }]}>
          <ToolInput name={name} input={input} />
          {result ? (
            <View style={{ gap: 4 }}>
              <T size="xs" weight="600" tone={result.isError ? 'danger' : 'dim'}>
                {result.isError ? 'ERROR' : 'OUTPUT'}
              </T>
              <Mono text={result.text || '(no output)'} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (name === 'Bash' && typeof input.command === 'string') return <Mono text={`$ ${input.command}`} />;
  if ((name === 'Edit' || name === 'MultiEdit') && typeof input.old_string === 'string') {
    return <DiffView lines={editToLines(input.old_string, String(input.new_string ?? ''))} numbers={false} />;
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (
      <View style={{ gap: space.sm }}>
        {(input.edits as { old_string?: string; new_string?: string }[]).map((e, i) => (
          <DiffView key={i} lines={editToLines(e.old_string ?? '', e.new_string ?? '')} numbers={false} />
        ))}
      </View>
    );
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return <DiffView lines={input.content.split('\n').map((t) => ({ type: 'add' as const, text: t }))} maxLines={40} numbers={false} />;
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return (
      <View style={{ gap: 4 }}>
        {(input.todos as { content?: string; status?: string }[]).map((t, i) => (
          <T key={i} size="sm" tone={t.status === 'completed' ? 'dim' : 'default'}>
            {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} {t.content}
          </T>
        ))}
      </View>
    );
  }
  return <Mono text={JSON.stringify(input, null, 2)} />;
}

function Mono({ text }: { text: string }) {
  const c = useColors();
  const clipped = text.length > 6000 ? text.slice(0, 6000) + `\n… (${text.length - 6000} more characters)` : text;
  return (
    <ScrollView horizontal style={{ backgroundColor: c.codeBg, borderRadius: radius.sm }} contentContainerStyle={{ padding: space.sm }}>
      <T size="xs" mono selectable>
        {clipped}
      </T>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, minHeight: 40 },
  body: { paddingHorizontal: space.md, paddingBottom: space.md },
});
