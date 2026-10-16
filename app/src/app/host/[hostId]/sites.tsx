import * as Haptics from 'expo-haptics';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Switch, View } from 'react-native';
import type { Site, SitesStatus } from '@protocol';
import { Badge, Button, EmptyState, Icon, IconButton, Loading, T } from '@/components/ui';
import { useConnection } from '@/lib/connections';
import { certBadge, KIND_LABEL } from '@/lib/sites';
import { basename, errorMessage } from '@/lib/util';
import { radius, space, useColors } from '@/theme';

/** All nginx sites on the server (optionally only one project's), with on/off switches. */
export default function Sites() {
  const c = useColors();
  const { hostId, project } = useLocalSearchParams<{ hostId: string; project?: string }>();
  const { client, state } = useConnection(hostId);
  const [status, setStatus] = useState<SitesStatus | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const st = await client.call('sites.status', {});
      setStatus(st);
      if (st.supported) setSites(await client.call('sites.list', {}));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      if (state === 'open') void load();
    }, [load, state]),
  );

  const toggle = async (site: Site, enabled: boolean) => {
    setBusy(site.name);
    try {
      const updated = await client!.call('sites.setEnabled', { name: site.name, enabled });
      setSites((list) => list?.map((s) => (s.name === site.name ? updated : s)) ?? null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert(enabled ? 'Couldn\'t enable the site' : 'Couldn\'t disable the site', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const shown = (sites ?? []).filter((s) => !project || s.projectPath === project).sort((a, b) => Number(a.protected) - Number(b.protected));
  const addDomain = () => router.push({ pathname: '/host/[hostId]/add-domain', params: { hostId, ...(project ? { project } : {}) } });

  return (
    <>
      <Stack.Screen
        options={{
          title: project ? `Domains · ${basename(project)}` : 'Websites & domains',
          headerRight: () => (status?.supported ? <IconButton icon="add" label="Add a domain" onPress={addDomain} /> : null),
        }}
      />
      {error ? (
        <EmptyState icon="alert-circle-outline" title="Couldn't load websites" body={error} action={<Button small title="Retry" onPress={load} />} />
      ) : !status ? (
        <Loading />
      ) : !status.supported ? (
        <EmptyState icon="globe-outline" title="Domains aren't available here" body={status.reason} />
      ) : sites === null ? (
        <Loading />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(s) => s.name}
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={c.accent} />}
          ListHeaderComponent={
            <T size="sm" tone="dim">
              {project
                ? 'Websites served from this project. Tap one for details, HTTPS and its nginx config.'
                : `nginx on this server${status.serverIp ? ` (${status.serverIp})` : ''}. Switch a site off to take it offline without deleting anything.`}
            </T>
          }
          ListEmptyComponent={
            <EmptyState
              icon="globe-outline"
              title={project ? 'No domain for this project yet' : 'No websites yet'}
              body="Point a domain at this server, and niCode sets up nginx and HTTPS in one go."
              action={<Button title="Add a domain" icon="add" onPress={addDomain} />}
            />
          }
          ListFooterComponent={shown.length ? <Button title="Add a domain" icon="add" kind="secondary" onPress={addDomain} /> : null}
          renderItem={({ item }) => {
            const cert = certBadge(item);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.domains[0] ?? item.name}, ${item.enabled ? 'on' : 'off'}`}
                onPress={() => router.push({ pathname: '/host/[hostId]/site', params: { hostId, name: item.name } })}
                style={({ pressed }) => [styles.card, { backgroundColor: pressed ? c.surfacePressed : c.surface, borderColor: c.border, opacity: item.enabled ? 1 : 0.7 }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Icon name={item.https ? 'lock-closed' : 'globe-outline'} size={20} color={item.enabled ? (item.https ? c.success : c.accent) : c.textFaint} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T weight="600" numberOfLines={1}>
                      {item.domains[0] ?? item.name}
                    </T>
                    <T size="sm" tone="dim" numberOfLines={1}>
                      {[KIND_LABEL[item.kind], item.projectPath ? basename(item.projectPath) : item.proxyPort ? `port ${item.proxyPort}` : item.root].filter(Boolean).join(' · ')}
                    </T>
                  </View>
                  {item.protected ? (
                    <Icon name="lock-closed-outline" size={18} color={c.textFaint} />
                  ) : (
                  <Switch
                    accessibilityLabel={`${item.enabled ? 'Disable' : 'Enable'} ${item.domains[0] ?? item.name}`}
                    value={item.enabled}
                    disabled={item.protected || busy === item.name}
                    onValueChange={(v) =>
                      v
                        ? void toggle(item, true)
                        : Alert.alert(`Take ${item.domains[0] ?? item.name} offline?`, 'The site stops being served until you switch it back on. Nothing is deleted.', [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Disable', style: 'destructive', onPress: () => void toggle(item, false) },
                          ])
                    }
                    trackColor={{ true: c.success, false: c.surface2 }}
                    thumbColor="#fff"
                  />
                  )}
                </View>
                <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                  <Badge text={item.enabled ? 'Online' : 'Disabled'} tone={item.enabled ? 'success' : 'default'} />
                  <Badge text={cert.text} tone={cert.tone} />
                  {item.domains.length > 1 ? <Badge text={`+${item.domains.length - 1} more`} /> : null}
                  {item.managedBy === 'panel' ? <Badge text="Managed in Panel" tone="accent" /> : item.protected ? <Badge text="niCode" tone="accent" /> : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
});
