import { ScrollView, StyleSheet, View } from 'react-native';
import { font, radius, space, useColors } from '@/theme';
import { T } from './ui';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Parses `git diff` unified output into display lines with line numbers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(raw);
      o = Number(m?.[1] ?? 0);
      n = Number(m?.[2] ?? 0);
      out.push({ type: 'hunk', text: m?.[3]?.trim() || raw });
    } else if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
      if (raw.startsWith('new file')) out.push({ type: 'meta', text: 'New file' });
      if (raw.startsWith('deleted file')) out.push({ type: 'meta', text: 'Deleted file' });
    } else if (raw.startsWith('+')) out.push({ type: 'add', text: raw.slice(1), newNo: n++ });
    else if (raw.startsWith('-')) out.push({ type: 'del', text: raw.slice(1), oldNo: o++ });
    else if (raw.startsWith('\\')) continue;
    else if (raw.length || o || n) out.push({ type: 'ctx', text: raw.slice(1), oldNo: o++, newNo: n++ });
  }
  return out;
}

/** Old → new string replacement (Claude's Edit tool) as diff lines. */
export function editToLines(oldStr: string, newStr: string): DiffLine[] {
  return [
    ...oldStr.split('\n').map((t) => ({ type: 'del' as const, text: t })),
    ...newStr.split('\n').map((t) => ({ type: 'add' as const, text: t })),
  ];
}

/** Native diff view: horizontal scroll for long lines, colored add/remove rows. */
export function DiffView({ lines, maxLines, numbers = true }: { lines: DiffLine[]; maxLines?: number; numbers?: boolean }) {
  const c = useColors();
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  return (
    <View style={[styles.box, { backgroundColor: c.codeBg, borderColor: c.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: '100%', paddingVertical: space.xs }}>
          {shown.map((l, i) =>
            l.type === 'hunk' || l.type === 'meta' ? (
              <T key={i} size="xs" tone="faint" mono style={styles.hunk}>
                {l.type === 'hunk' ? `⋯ ${l.text}` : l.text}
              </T>
            ) : (
              <View key={i} style={[styles.line, { backgroundColor: l.type === 'add' ? c.diffAdd : l.type === 'del' ? c.diffDel : 'transparent' }]}>
                {numbers ? (
                  <T size="xs" mono tone="faint" style={styles.no}>
                    {l.type === 'add' ? '' : (l.oldNo ?? '')}
                  </T>
                ) : null}
                {numbers ? (
                  <T size="xs" mono tone="faint" style={styles.no}>
                    {l.type === 'del' ? '' : (l.newNo ?? '')}
                  </T>
                ) : null}
                <T size="xs" mono style={{ color: l.type === 'add' ? c.success : l.type === 'del' ? c.danger : c.textFaint, width: 14 }}>
                  {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                </T>
                <T size="xs" mono style={{ color: c.text, fontFamily: font.mono }}>
                  {l.text || ' '}
                </T>
              </View>
            ),
          )}
          {maxLines && lines.length > maxLines ? (
            <T size="xs" tone="faint" style={styles.hunk}>
              … {lines.length - maxLines} more lines
            </T>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  line: { flexDirection: 'row', paddingRight: space.md },
  no: { width: 34, textAlign: 'right', paddingRight: 6 },
  hunk: { paddingHorizontal: space.md, paddingVertical: 4 },
});
