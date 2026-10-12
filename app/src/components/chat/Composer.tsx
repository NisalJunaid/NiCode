import { useState } from 'react';
import { Keyboard, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PermissionMode } from '@protocol';
import { font, radius, space, useColors } from '@/theme';
import { Icon, IconButton, Segmented, T } from '../ui';

export const MODE_INFO: Record<PermissionMode, { label: string; desc: string; icon: 'hand-left-outline' | 'create-outline' | 'map-outline' | 'flash-outline' | 'warning-outline' }> = {
  default: { label: 'Ask first', desc: 'Claude asks before editing files or running commands.', icon: 'hand-left-outline' },
  acceptEdits: { label: 'Auto-edit', desc: 'Edits files freely; still asks before running commands.', icon: 'create-outline' },
  plan: { label: 'Plan only', desc: 'Reads and proposes a plan. Changes nothing.', icon: 'map-outline' },
  auto: { label: 'Auto', desc: 'Claude decides routine actions itself and asks only for risky ones.', icon: 'flash-outline' },
  bypassPermissions: { label: 'No limits', desc: 'Never asks. Only for throwaway projects.', icon: 'warning-outline' },
};

const MODELS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

interface Props {
  running: boolean;
  disabled?: boolean;
  mode: PermissionMode;
  model: string;
  modes: PermissionMode[];
  placeholder?: string;
  onSend: (text: string) => Promise<boolean> | boolean;
  onStop: () => void;
  onChangeMode: (m: PermissionMode) => void;
  onChangeModel: (m: string) => void;
}

/** Message box + mode/model chip + send/stop. Grows with the text; send never hides behind the keyboard. */
export function Composer({ running, disabled, mode, model, modes, placeholder, onSend, onStop, onChangeMode, onChangeModel }: Props) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState(false);
  const canSend = !!text.trim() && !disabled && !running;
  const info = MODE_INFO[mode];

  const send = async () => {
    if (!canSend) return;
    const t = text;
    setText('');
    Keyboard.dismiss(); // give the conversation the screen while Claude works
    const ok = await onSend(t.trim());
    if (!ok) setText(t); // keep the draft if sending failed
  };

  return (
    <View style={[styles.wrap, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: space.sm }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Mode: ${info.label}. Change`} onPress={() => setSheet(true)} style={[styles.modeChip, { backgroundColor: c.surface2 }]}>
        <Icon name={info.icon} size={14} color={mode === 'bypassPermissions' ? c.danger : c.accent} />
        <T size="xs" weight="600">
          {info.label}
          {model ? ` · ${MODELS.find((m) => m.value === model)?.label ?? model}` : ''}
        </T>
        <Icon name="chevron-down" size={12} color={c.textDim} />
      </Pressable>
      <View style={[styles.inputRow, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? (running ? 'Claude is working…' : 'Ask Claude to do something')}
          placeholderTextColor={c.textFaint}
          selectionColor={c.accent}
          multiline
          editable={!disabled}
          style={[styles.input, { color: c.text }]}
        />
        {running ? (
          <IconButton icon="stop" label="Stop Claude" onPress={onStop} filled color={c.onAccent} size={18} />
        ) : (
          <IconButton icon="arrow-up" label="Send" onPress={send} filled disabled={!canSend} size={20} />
        )}
      </View>

      <Modal visible={sheet} transparent animationType="fade" onRequestClose={() => setSheet(false)}>
        <Pressable style={[styles.backdrop, { backgroundColor: c.overlay }]} onPress={() => setSheet(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + space.lg }]} onPress={() => undefined}>
            <T size="lg" weight="700">
              How should Claude work?
            </T>
            {modes.map((m) => {
              const mi = MODE_INFO[m];
              const active = m === mode;
              return (
                <Pressable
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    onChangeMode(m);
                    setSheet(false);
                  }}
                  style={[styles.option, { borderColor: active ? c.accent : c.border, backgroundColor: active ? c.accentSoft : 'transparent' }]}
                >
                  <Icon name={mi.icon} size={20} color={m === 'bypassPermissions' ? c.danger : active ? c.accent : c.textDim} />
                  <View style={{ flex: 1 }}>
                    <T weight="600">{mi.label}</T>
                    <T size="sm" tone="dim">
                      {mi.desc}
                    </T>
                  </View>
                  {active ? <Icon name="checkmark" size={18} color={c.accent} /> : null}
                </Pressable>
              );
            })}
            <T size="sm" weight="600" tone="dim" style={{ marginTop: space.sm }}>
              Model
            </T>
            <Segmented value={model as (typeof MODELS)[number]['value']} onChange={onChangeModel} options={MODELS.map((m) => ({ value: m.value, label: m.label }))} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },
  modeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: space.md, height: 30, borderRadius: radius.pill },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, paddingLeft: space.md, paddingRight: 4, paddingVertical: 4 },
  input: { flex: 1, fontSize: font.size.md, maxHeight: 160, minHeight: 36, paddingTop: 8, paddingBottom: 8 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, gap: space.sm },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md },
});
