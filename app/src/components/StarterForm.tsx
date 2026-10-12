import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { DB_LABEL, type Db, EXTRA_LABEL, type Extra, STACKS, type Stack, type StarterChoice } from '@/lib/starters';
import { radius, space, useColors } from '@/theme';
import { Banner, Button, Field, Icon, Segmented, T } from './ui';

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Pick a stack, language, database and extras; Claude scaffolds it in the new project. */
export function StarterForm({ busy, claudeReady, onCreate }: { busy: boolean; claudeReady: boolean; onCreate: (c: StarterChoice) => void }) {
  const c = useColors();
  const [name, setName] = useState('');
  const [stack, setStack] = useState<Stack>(STACKS[0]!);
  const [language, setLanguage] = useState<'ts' | 'js'>('ts');
  const [db, setDb] = useState<Db>(STACKS[0]!.dbs[0]!);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [notes, setNotes] = useState('');

  const pickStack = (s: Stack) => {
    setStack(s);
    setDb(s.dbs[0]!);
    setExtras((e) => e.filter((x) => s.extras.includes(x)));
  };
  const toggleExtra = (e: Extra) => setExtras((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  const valid = NAME_RE.test(name);
  const blank = stack.id === 'blank';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.lg }} keyboardShouldPersistTaps="handled">
        <Field
          label="Project name"
          placeholder="my-new-app"
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          hint={name && !valid ? 'Use letters, numbers, dots, dashes or underscores.' : 'Becomes the folder name.'}
        />

        <View style={{ gap: space.sm }}>
          <T size="sm" weight="600" tone="dim">
            What are you building?
          </T>
          <View style={styles.grid}>
            {STACKS.map((s) => {
              const active = s.id === stack.id;
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => pickStack(s)}
                  style={({ pressed }) => [
                    styles.tile,
                    { backgroundColor: active ? c.accentSoft : c.surface, borderColor: active ? c.accent : c.border },
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Icon name={s.icon} size={22} color={active ? c.accent : c.textDim} />
                  <T weight="600" size="sm" numberOfLines={1}>
                    {s.name}
                  </T>
                  <T size="xs" tone="dim" numberOfLines={2}>
                    {s.blurb}
                  </T>
                </Pressable>
              );
            })}
          </View>
        </View>

        {stack.language ? (
          <View style={{ gap: space.sm }}>
            <T size="sm" weight="600" tone="dim">
              Language
            </T>
            <Segmented
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'ts', label: 'TypeScript' },
                { value: 'js', label: 'JavaScript' },
              ]}
            />
          </View>
        ) : null}

        {stack.dbs.length > 1 ? (
          <ChipGroup title="Database">
            {stack.dbs.map((d) => (
              <Chip key={d} label={DB_LABEL[d]} active={db === d} onPress={() => setDb(d)} />
            ))}
          </ChipGroup>
        ) : null}

        {stack.extras.length ? (
          <ChipGroup title="Include">
            {stack.extras.map((e) => (
              <Chip key={e} label={EXTRA_LABEL[e]} active={extras.includes(e)} check onPress={() => toggleExtra(e)} />
            ))}
          </ChipGroup>
        ) : null}

        {!blank ? (
          <Field
            label="Anything else? (optional)"
            placeholder="e.g. a landing page with a pricing section, dark mode"
            value={notes}
            onChangeText={setNotes}
            multiline
            style={{ minHeight: 80, paddingTop: space.md, textAlignVertical: 'top' }}
          />
        ) : null}

        {!blank && !claudeReady ? (
          <Banner tone="warning" icon="key-outline" title="Claude isn't logged in on this server" body="The folder will be created; log in to Claude to let it set up the project." />
        ) : null}
        {!blank && claudeReady ? (
          <T size="sm" tone="dim">
            Claude will set this up using {stack.name}&apos;s official tools and show its progress in the chat. It edits files freely in this new folder and asks before running commands.
          </T>
        ) : null}

        <Button
          title={blank ? 'Create folder' : 'Create & set up with Claude'}
          icon={blank ? 'folder-outline' : 'sparkles-outline'}
          loading={busy}
          disabled={!valid}
          onPress={() => onCreate({ name, stack, language, db, extras, notes })}
        />
      </KeyboardAwareScrollView>
    </KeyboardAvoidingView>
  );
}

function ChipGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <T size="sm" weight="600" tone="dim">
        {title}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{children}</View>
    </View>
  );
}

function Chip({ label, active, check, onPress }: { label: string; active: boolean; check?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={check ? 'checkbox' : 'radio'}
      accessibilityState={check ? { checked: active } : { selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: active ? c.accentSoft : c.surface, borderColor: active ? c.accent : c.border },
        pressed && { opacity: 0.8 },
      ]}
    >
      {check ? <Icon name={active ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={active ? c.accent : c.textFaint} /> : null}
      <T size="sm" weight={active ? '600' : '500'} style={{ color: active ? c.accent : c.text }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: { width: '48.5%', borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: 4, minHeight: 92 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 38 },
});
