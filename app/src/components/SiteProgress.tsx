import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { EventData, SiteStep } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { space, useColors } from '@/theme';
import { Card, Icon, T } from './ui';

type StepState = EventData<'sites.progress'>;

const LABEL: Record<SiteStep, string> = {
  folder: 'Project folder',
  config: 'nginx site config',
  enable: 'Enable site',
  test: 'Check nginx config',
  reload: 'Reload nginx',
  certbot: 'HTTPS certificate',
};
const ORDER: SiteStep[] = ['folder', 'config', 'enable', 'test', 'reload', 'certbot'];

/** Collects live sites.progress events for one operation. */
export function useSiteProgress(client: NicodeClient | null, opId: string | null): Partial<Record<SiteStep, StepState>> {
  // Steps are stored per operation id, so a new operation starts empty without resetting state.
  const [data, setData] = useState<{ id: string | null; steps: Partial<Record<SiteStep, StepState>> }>({ id: null, steps: {} });
  useEffect(() => {
    if (!client || !opId) return;
    return client.on('sites.progress', (e) => {
      if (e.opId !== opId) return;
      setData((d) => ({ id: opId, steps: { ...(d.id === opId ? d.steps : {}), [e.step]: e } }));
    });
  }, [client, opId]);
  return data.id === opId ? data.steps : {};
}

/** Checklist of setup steps: pending / spinner / ✓ / ✗ with a detail line. */
export function SiteProgress({ steps, only }: { steps: Partial<Record<SiteStep, StepState>>; only?: SiteStep[] }) {
  const c = useColors();
  return (
    <Card>
      {(only ?? ORDER).map((step) => {
        const s = steps[step];
        const icon =
          s?.status === 'done' ? <Icon name="checkmark-circle" size={20} color={c.success} />
          : s?.status === 'failed' ? <Icon name="close-circle" size={20} color={c.danger} />
          : s?.status === 'skipped' ? <Icon name="remove-circle-outline" size={20} color={c.textFaint} />
          : s?.status === 'running' ? <ActivityIndicator size="small" color={c.accent} />
          : <Icon name="ellipse-outline" size={20} color={c.textFaint} />;
        return (
          <View key={step} style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start', paddingVertical: 4 }}>
            <View style={{ width: 22, alignItems: 'center', paddingTop: 1 }}>{icon}</View>
            <View style={{ flex: 1 }}>
              <T weight={s?.status === 'running' ? '600' : '500'} tone={s ? 'default' : 'faint'}>
                {LABEL[step]}
                {s?.status === 'skipped' ? ' (skipped)' : ''}
              </T>
              {s?.detail ? (
                <T size="sm" tone={s.status === 'failed' ? 'danger' : 'dim'}>
                  {s.detail}
                </T>
              ) : null}
            </View>
          </View>
        );
      })}
    </Card>
  );
}
