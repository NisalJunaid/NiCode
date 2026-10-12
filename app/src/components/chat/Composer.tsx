import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PermissionMode } from '@protocol';
import { type Attachment, MAX_IMAGES, pickImages } from '@/lib/attachments';
import { errorMessage } from '@/lib/util';
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
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean> | boolean;
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(false);
  const canSend = (!!text.trim() || attachments.length > 0) && !disabled && !running && !picking;
  const info = MODE_INFO[mode];

  const send = async () => {
    if (!canSend) return;
    const t = text;
    const a = attachments;
    setText('');
    setAttachments([]);
    Keyboard.dismiss(); // give the conversation the screen while Claude works
    const ok = await onSend(t.trim() || (a.length > 1 ? 'Take a look at these images.' : 'Take a look at this image.'), a);
    if (!ok) {
      // keep the draft if sending failed
      setText(t);
      setAttachments(a);
    }
  };

  const pick = async (source: 'camera' | 'library') => {
    setPicking(true);
    try {
      const more = await pickImages(source, MAX_IMAGES - attachments.length);
      setAttachments((cur) => [...cur, ...more].slice(0, MAX_IMAGES));
    } catch (err) {
      Alert.alert("Couldn't add the image", errorMessage(err));
    } finally {
      setPicking(false);
    }
  };
  const attach = () => {
    if (attachments.length >= MAX_IMAGES) return Alert.alert(`Up to ${MAX_IMAGES} images per message`);
    Alert.alert('Add an image', 'Screenshots, photos of a screen or a sketch. Claude can see them.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Take photo', onPress: () => void pick('camera') },
      { text: 'Choose', onPress: () => void pick('library') },
    ]);
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
      {attachments.length || picking ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">
          {attachments.map((a, i) => (
            <View key={a.uri}>
              <Image source={{ uri: a.uri }} style={[styles.thumb, { borderColor: c.border }]} contentFit="cover" accessibilityLabel={`Attached image ${i + 1}`} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove image ${i + 1}`}
                hitSlop={8}
                onPress={() => setAttachments((cur) => cur.filter((x) => x.uri !== a.uri))}
                style={[styles.thumbX, { backgroundColor: c.overlay }]}
              >
                <Icon name="close" size={14} color="#fff" />
              </Pressable>
            </View>
          ))}
          {picking ? (
            <View style={[styles.thumb, { borderColor: c.border, alignItems: 'center', justifyContent: 'center' }]}>
              <ActivityIndicator color={c.accent} />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      <View style={[styles.inputRow, { backgroundColor: c.surface, borderColor: c.border }]}>
        <IconButton icon="image-outline" label="Attach an image" onPress={attach} disabled={disabled || running || picking} size={20} />
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
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, paddingLeft: 2, paddingRight: 4, paddingVertical: 4 },
  thumb: { width: 64, height: 64, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  thumbX: { position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: font.size.md, maxHeight: 160, minHeight: 36, paddingTop: 8, paddingBottom: 8 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, gap: space.sm },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md },
});
