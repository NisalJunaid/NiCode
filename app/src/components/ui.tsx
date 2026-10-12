/**
 * Shared UI primitives. Every screen is built from these so spacing, touch targets
 * (≥ 44pt) and colors stay consistent in light and dark mode.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  type ColorValue,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HIT, font, radius, space, useColors } from '@/theme';
import { LogoLoader } from './Logo';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color?: ColorValue }) {
  const c = useColors();
  return <Ionicons name={name} size={size} color={color ?? c.text} />;
}

type Tone = 'default' | 'dim' | 'faint' | 'accent' | 'danger' | 'success' | 'warning';

export function T({
  children,
  size = 'md',
  weight,
  tone = 'default',
  mono,
  style,
  ...rest
}: TextProps & { size?: keyof typeof font.size; weight?: '400' | '500' | '600' | '700'; tone?: Tone; mono?: boolean }) {
  const c = useColors();
  const color = { default: c.text, dim: c.textDim, faint: c.textFaint, accent: c.accent, danger: c.danger, success: c.success, warning: c.warning }[tone];
  return (
    <Text
      {...rest}
      style={[{ color, fontSize: font.size[size], fontWeight: weight ?? '400', lineHeight: Math.round(font.size[size] * 1.4) }, mono && { fontFamily: font.mono }, style]}
    >
      {children}
    </Text>
  );
}

export function Screen({ children, scroll, padded = true, style }: { children: ReactNode; scroll?: boolean; padded?: boolean; style?: ViewStyle }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const inner = [{ padding: padded ? space.lg : 0, gap: space.lg }, style];
  if (scroll) {
    return (
      // Keeps the focused field above the keyboard (Android edge-to-edge doesn't resize the window).
      <KeyboardAwareScrollView
        bottomOffset={24}
        style={{ flex: 1, backgroundColor: c.bg }}
        contentContainerStyle={[...inner, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </KeyboardAwareScrollView>
    );
  }
  return <View style={[{ flex: 1, backgroundColor: c.bg }, ...inner]}>{children}</View>;
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  kind = 'primary',
  icon,
  loading,
  disabled,
  small,
  style,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
}) {
  const c = useColors();
  const bg = { primary: c.accent, secondary: c.surface2, ghost: 'transparent', danger: c.dangerSoft }[kind];
  const fg = { primary: c.onAccent, secondary: c.text, ghost: c.accent, danger: c.danger }[kind];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, minHeight: small ? 36 : HIT + 4, paddingHorizontal: small ? space.md : space.lg, opacity: off ? 0.5 : pressed ? 0.8 : 1 },
        kind === 'secondary' && { borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={small ? 16 : 18} color={fg} /> : null}
      <T weight="600" size={small ? 'sm' : 'md'} style={{ color: fg }}>
        {title}
      </T>
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  color,
  size = 22,
  disabled,
  filled,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  color?: string;
  size?: number;
  disabled?: boolean;
  filled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        filled && { backgroundColor: c.accent },
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}
    >
      <Icon name={icon} size={size} color={color ?? (filled ? c.onAccent : c.text)} />
    </Pressable>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: ViewStyle; onPress?: () => void }) {
  const c = useColors();
  const base = [styles.card, { backgroundColor: c.surface, borderColor: c.border }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [...base, pressed && { backgroundColor: c.surfacePressed }]}>
      {children}
    </Pressable>
  );
}

/** A tappable list row: icon, title, subtitle, trailing content or chevron. */
export function Row({
  icon,
  iconColor,
  title,
  subtitle,
  right,
  onPress,
  onLongPress,
  chevron = !!onPress,
  danger,
  mono,
}: {
  icon?: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  chevron?: boolean;
  danger?: boolean;
  mono?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress && !onLongPress}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surfacePressed }]}
    >
      {icon ? <Icon name={icon} size={20} color={iconColor ?? (danger ? c.danger : c.textDim)} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={1} tone={danger ? 'danger' : 'default'} mono={mono} weight="500">
          {title}
        </T>
        {subtitle ? (
          <T size="sm" tone="dim" numberOfLines={2}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right}
      {chevron ? <Icon name="chevron-forward" size={18} color={c.textFaint} /> : null}
    </Pressable>
  );
}

/** Grouped list section (iOS-settings style), works on both platforms. */
export function Section({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: space.sm }}>
      {title ? (
        <T size="xs" weight="600" tone="dim" style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginLeft: space.xs }}>
          {title}
        </T>
      ) : null}
      <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>{children}</View>
      {footer ? (
        <T size="sm" tone="faint" style={{ marginHorizontal: space.xs }}>
          {footer}
        </T>
      ) : null}
    </View>
  );
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: space.lg }} />;
}

export function Field({ label, hint, style, ...input }: TextInputProps & { label?: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      {label ? (
        <T size="sm" weight="600" tone="dim">
          {label}
        </T>
      ) : null}
      <TextInput
        placeholderTextColor={c.textFaint}
        selectionColor={c.accent}
        {...input}
        style={[styles.field, { backgroundColor: c.surface, borderColor: c.border, color: c.text }, style]}
      />
      {hint ? (
        <T size="sm" tone="faint">
          {hint}
        </T>
      ) : null}
    </View>
  );
}

export function Badge({ text, tone = 'default' }: { text: string; tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' }) {
  const c = useColors();
  const map = {
    default: [c.surface2, c.textDim],
    accent: [c.accentSoft, c.accent],
    success: [c.successSoft, c.success],
    warning: [c.warningSoft, c.warning],
    danger: [c.dangerSoft, c.danger],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <T size="xs" weight="600" style={{ color: fg }}>
        {text}
      </T>
    </View>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'busy' | 'off' | 'bad' }) {
  const c = useColors();
  const color = { ok: c.success, busy: c.warning, off: c.textFaint, bad: c.danger }[tone];
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />;
}

export function Banner({
  tone = 'accent',
  icon,
  title,
  body,
  action,
}: {
  tone?: 'accent' | 'warning' | 'danger' | 'success';
  icon: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  const c = useColors();
  const [bg, fg] = { accent: [c.accentSoft, c.accent], warning: [c.warningSoft, c.warning], danger: [c.dangerSoft, c.danger], success: [c.successSoft, c.success] }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Icon name={icon} size={20} color={fg} />
      <View style={{ flex: 1, gap: 2 }}>
        <T weight="600">{title}</T>
        {body ? (
          <T size="sm" tone="dim">
            {body}
          </T>
        ) : null}
        {action ? <View style={{ marginTop: space.sm, alignItems: 'flex-start' }}>{action}</View> : null}
      </View>
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: c.surface2 }]}>
        <Icon name={icon} size={28} color={c.textDim} />
      </View>
      <T size="lg" weight="600" style={{ textAlign: 'center' }}>
        {title}
      </T>
      {body ? (
        <T tone="dim" style={{ textAlign: 'center' }}>
          {body}
        </T>
      ) : null}
      {action}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={[styles.empty, { flex: 1 }]}>
      <LogoLoader size={56} />
      {label ? <T tone="dim">{label}</T> : null}
    </View>
  );
}

/** Horizontal choice of 2–4 options. */
export function Segmented<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const c = useColors();
  return (
    <View style={[styles.segmented, { backgroundColor: c.surface2 }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, active && { backgroundColor: c.surface, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}
          >
            <T size="sm" weight={active ? '600' : '500'} tone={active ? 'default' : 'dim'}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, borderRadius: radius.md },
  iconButton: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center', borderRadius: HIT / 2 },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HIT + 8, paddingHorizontal: space.lg, paddingVertical: space.sm },
  section: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  field: { minHeight: HIT + 4, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md, fontSize: font.size.md },
  badge: { paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, alignSelf: 'flex-start' },
  banner: { flexDirection: 'row', gap: space.md, padding: space.lg, borderRadius: radius.lg, alignItems: 'flex-start' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xxl },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  segmented: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 3 },
  segment: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
});
