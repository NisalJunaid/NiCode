import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { TAG, TAG_SPACE } from './logoGlyphs';

/**
 * The NiCode wordmark, redrawn as vector strokes from nicode.png: monoline "N i C … e" and the
 * blue→red infinity "od" (one continuous stroke, starting at the d's stem), plus the tagline
 * "Code Without Borders.". Units are the original 318×101 artwork's pixels.
 *
 * `animated` plays the intro: the infinity draws itself, the letters write in, the i's dot pops,
 * a light runs along the infinity, and the tagline fades in letter by letter.
 */

export const BLUE = '#0096C7';
export const RED = '#E8202A';
const MID = '#7A7B7E';

const VB_W = 318;
const VB_H = 101;
const VB_H_NO_TAG = 82;
const SW = 11;

// Infinity: stem down → right-lower quarter of the d → S to the o's top → the o's left half →
// S to the d's top → right-upper quarter back to the stem.
const INF_D =
  'M248,1 V50 A23.5,23.5 0 0 1 224.5,73.5 C200.5,73.5 188,26.5 164,26.5 A23.5,23.5 0 0 0 164,73.5 C188,73.5 200.5,26.5 224.5,26.5 A23.5,23.5 0 0 1 248,50';
const INF_LEN = 356;
const N_D = 'M5.5,78 V13 L58.5,72 V7';
const N_LEN = 210;
const I_D = 'M78.5,28 V78';
const I_LEN = 50;
const C_D = 'M147.051,20.088 A29,32 0 1 0 144.905,65.281';
const C_LEN = 143;
const E_D = 'M263,50.5 H311 A24,24 0 1 0 305.385,65.927';
const E_LEN = 183;

// Tagline: Poppins Light, cap height 11, spread over x 43–268 with a baseline at 99.5.
const TAG_TEXT = 'Code Without Borders.';
const TAG_SCALE = 11 / 700;
const TAG_TRACK = 2.6;
const TAG_BASE = 99.5;
const tagLetters = (() => {
  const out: { ch: string; x: number }[] = [];
  let x = 43;
  for (const ch of TAG_TEXT) {
    if (ch !== ' ') out.push({ ch, x });
    x += (ch === ' ' ? TAG_SPACE : TAG[ch]!.adv) * TAG_SCALE + TAG_TRACK;
  }
  return out;
})();

const APath = Animated.createAnimatedComponent(Path);
const ACircle = Animated.createAnimatedComponent(Circle);

/** strokeDashoffset for a stroke drawn `p` (0..1) of the way. */
function useDraw(p: SharedValue<number>, len: number) {
  return useAnimatedProps(() => ({ strokeDashoffset: len * (1 - p.value) }));
}

function InfinityGradient({ id }: { id: string }) {
  return (
    <Defs>
      <LinearGradient id={id} gradientUnits="userSpaceOnUse" x1="138" y1="0" x2="253" y2="0">
        <Stop offset="0" stopColor={BLUE} />
        <Stop offset="0.45" stopColor={MID} />
        <Stop offset="1" stopColor={RED} />
      </LinearGradient>
    </Defs>
  );
}

export function Logo({
  width,
  color,
  tagColor,
  tagline = true,
  animated = false,
  play = true,
  onDone,
}: {
  width: number;
  color: string;
  tagColor?: string;
  /** false = just the wordmark (e.g. in a header). */
  tagline?: boolean;
  animated?: boolean;
  /** With `animated`: start once this is true (e.g. after the native splash has gone). */
  play?: boolean;
  onDone?: () => void;
}) {
  const start = animated ? 0 : 1;
  const inf = useSharedValue(start);
  const n = useSharedValue(start);
  const i = useSharedValue(start);
  const dot = useSharedValue(start);
  const c = useSharedValue(start);
  const e = useSharedValue(start);
  const shine = useSharedValue(0);
  const tag = useSharedValue(start);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (!animated || !play) return;
    const draw = (sv: SharedValue<number>, delay: number, duration: number) => sv.set(withDelay(delay, withTiming(1, { duration, easing: Easing.inOut(Easing.cubic) })));
    draw(inf, 150, 1250);
    draw(n, 450, 650);
    draw(c, 550, 650);
    draw(i, 700, 250);
    dot.set(withDelay(900, withSpring(1, { damping: 7, stiffness: 220 })));
    draw(e, 800, 600);
    shine.set(withDelay(1400, withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) })));
    pulse.set(withDelay(1400, withSequence(withTiming(1.035, { duration: 180, easing: Easing.out(Easing.quad) }), withSpring(1, { damping: 9, stiffness: 160 }))));
    tag.set(withDelay(1550, withTiming(1, { duration: 800, easing: Easing.linear })));
    if (onDone) {
      const t = setTimeout(onDone, 2900);
      return () => clearTimeout(t);
    }
  }, [animated, play, inf, n, i, dot, c, e, shine, tag, pulse, onDone]);

  const infProps = useDraw(inf, INF_LEN);
  const nProps = useDraw(n, N_LEN);
  const iProps = useDraw(i, I_LEN);
  const cProps = useDraw(c, C_LEN);
  const eProps = useDraw(e, E_LEN);
  const dotProps = useAnimatedProps(() => ({ r: 7 * dot.value }));
  // A short bright dash running once along the infinity.
  const shineProps = useAnimatedProps(() => ({
    strokeDashoffset: 40 - shine.value * (INF_LEN + 40),
    strokeOpacity: interpolate(shine.value, [0, 0.08, 0.85, 1], [0, 0.85, 0.85, 0]),
  }));
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  const vbH = tagline ? VB_H : VB_H_NO_TAG;
  const height = (width * vbH) / VB_W;
  const tc = tagColor ?? color;
  const gid = animated ? 'nicodeGradA' : 'nicodeGrad';

  return (
    <Animated.View style={[{ width, height }, pulseStyle]} accessible accessibilityRole="image" accessibilityLabel="NiCode, Code Without Borders">
      <Svg width={width} height={height} viewBox={`0 0 ${VB_W} ${vbH}`}>
        <InfinityGradient id={gid} />
        <G fill="none" stroke={color} strokeWidth={SW}>
          <APath d={N_D} strokeLinejoin="bevel" strokeDasharray={[N_LEN, N_LEN]} animatedProps={nProps} />
          <APath d={I_D} strokeDasharray={[I_LEN, I_LEN]} animatedProps={iProps} />
          <APath d={C_D} strokeDasharray={[C_LEN, C_LEN]} animatedProps={cProps} />
          <APath d={E_D} strokeDasharray={[E_LEN, E_LEN]} animatedProps={eProps} />
        </G>
        <ACircle cx={79} cy={15} fill={color} animatedProps={dotProps} />
        <APath d={INF_D} fill="none" stroke={`url(#${gid})`} strokeWidth={SW} strokeDasharray={[INF_LEN, INF_LEN]} animatedProps={infProps} />
        {animated ? (
          <APath d={INF_D} fill="none" stroke="#FFFFFF" strokeWidth={SW * 0.45} strokeLinecap="round" strokeDasharray={[40, INF_LEN + 80]} animatedProps={shineProps} />
        ) : null}
        {tagline ? tagLetters.map((l, k) => <TagLetter key={k} index={k} count={tagLetters.length} progress={tag} x={l.x} ch={l.ch} color={tc} />) : null}
      </Svg>
    </Animated.View>
  );
}

function TagLetter({ index, count, progress, x, ch, color }: { index: number; count: number; progress: SharedValue<number>; x: number; ch: string; color: string }) {
  const props = useAnimatedProps(() => {
    const from = (index / count) * 0.65;
    return { opacity: interpolate(progress.value, [from, from + 0.35], [0, 1], 'clamp') };
  });
  return <APath d={TAG[ch]!.d} fill={color} transform={`translate(${x.toFixed(2)} ${TAG_BASE}) scale(${TAG_SCALE})`} animatedProps={props} />;
}

/** Loading indicator: the infinity drawing itself and un-drawing, on a loop. */
export function LogoLoader({ size = 64 }: { size?: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.set(withRepeat(withTiming(2, { duration: 1800, easing: Easing.inOut(Easing.cubic) }), -1, false));
  }, [p]);
  // 0→1 draws from the stem, 1→2 erases from the stem: the stroke "travels" around the loop.
  const props = useAnimatedProps(() => ({ strokeDashoffset: INF_LEN * (1 - p.value) }));
  const h = (size * 92) / 132;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading">
      <Svg width={size} height={h} viewBox="128 -6 132 92">
        <InfinityGradient id="nicodeGradL" />
        <Path d={INF_D} fill="none" stroke="url(#nicodeGradL)" strokeOpacity={0.15} strokeWidth={SW} />
        <APath d={INF_D} fill="none" stroke="url(#nicodeGradL)" strokeWidth={SW} strokeLinecap="round" strokeDasharray={[INF_LEN, INF_LEN]} animatedProps={props} />
      </Svg>
    </View>
  );
}
