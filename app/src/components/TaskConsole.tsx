import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import type { TaskStepState } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { radius, space, useColors } from '@/theme';
import { Card, Icon, T } from './ui';

const MAX = 60_000;

/** Live output + steps of one server operation (task, build, app start, deploy), by opId. */
export function useTaskStream(client: NicodeClient | null, opId: string | null): { output: string; steps: TaskStepState[] } {
  const [data, setData] = useState<{ id: string | null; output: string; steps: TaskStepState[] }>({ id: null, output: '', steps: [] });
  useEffect(() => {
    if (!client || !opId) return;
    const fresh = (d: typeof data) => (d.id === opId ? d : { id: opId, output: '', steps: [] });
    const a = client.on('tasks.output', (e) => {
      if (e.opId === opId) setData((d) => ({ ...fresh(d), output: (fresh(d).output + e.chunk).slice(-MAX) }));
    });
    const b = client.on('tasks.step', (e) => {
      if (e.opId !== opId) return;
      setData((d) => {
        const cur = fresh(d);
        const { opId: _id, ...s } = e;
        const i = cur.steps.findIndex((x) => x.step === s.step);
        const steps = i >= 0 ? cur.steps.map((x, j) => (j === i ? s : x)) : [...cur.steps, s];
        return { ...cur, steps };
      });
    });
    return () => {
      a();
      b();
    };
  }, [client, opId]);
  return data.id === opId ? { output: data.output, steps: data.steps } : { output: '', steps: [] };
}

export function StepList({ steps }: { steps: TaskStepState[] }) {
  const c = useColors();
  if (!steps.length) return null;
  return (
    <Card>
      {steps.map((s) => (
        <View key={s.step} style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start', paddingVertical: 3 }}>
          <View style={{ width: 22, alignItems: 'center', paddingTop: 1 }}>
            {s.status === 'running' ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Icon
                name={s.status === 'done' ? 'checkmark-circle' : s.status === 'failed' ? 'close-circle' : 'remove-circle-outline'}
                size={20}
                color={s.status === 'done' ? c.success : s.status === 'failed' ? c.danger : c.textFaint}
              />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <T weight={s.status === 'running' ? '600' : '500'}>
              {s.label}
              {s.status === 'skipped' ? ' (skipped)' : ''}
            </T>
            {s.detail ? (
              <T size="sm" tone={s.status === 'failed' ? 'danger' : 'dim'} mono={s.status === 'running'} numberOfLines={4}>
                {s.detail}
              </T>
            ) : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

/** Terminal-style output box that follows new output. */
export function OutputBox({ text, placeholder, height = 260 }: { text: string; placeholder?: string; height?: number }) {
  const c = useColors();
  const ref = useRef<ScrollView>(null);
  return (
    <View style={{ backgroundColor: c.codeBg, borderRadius: radius.md, height, borderWidth: 1, borderColor: c.border }}>
      <ScrollView ref={ref} onContentSizeChange={() => ref.current?.scrollToEnd({ animated: false })} contentContainerStyle={{ padding: space.md }}>
        <T mono size="xs" selectable tone={text ? 'default' : 'faint'}>
          {text || placeholder || 'Waiting for output…'}
        </T>
      </ScrollView>
    </View>
  );
}
