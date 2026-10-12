import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { BOLD, LIGHT } from './logoGlyphs';

/**
 * The niCode wordmark: "Ni", a blue/red capsule with an "O" in it, "e", and the CODE ANYWHERE tagline.
 * Everything is vector (glyph paths from Poppins), in "logo units"; `width` scales it.
 * `animated` plays the intro: Ni glides in from the centre, the capsule lines draw, the O draws and pops,
 * the e slides out, then the tagline letters rise in and a blue/red line grows under them.
 */

export const BLUE = '#3B82C4';
export const RED = '#E5232B';

// ── geometry (logo units) ──
const FS = 0.1; // glyph units → logo units (font size 100)
const H = 104; // wordmark height = capsule height
const BASE = 87; // letter baseline (cap height centred on the capsule)
const SW = 15; // capsule / O stroke
const CAP_W = 235;
const GAP = 6;
const N_X = 0;
const I_X = BOLD.N.adv * FS;
const CAP_X = I_X + BOLD.i.adv * FS + GAP;
const E_X = CAP_X + CAP_W + GAP;
const W = E_X + BOLD.e.adv * FS;

const T = SW / 2;
const R = (H - SW) / 2; // capsule end radius (stroke centre)
const MID = CAP_W / 2;
const BLUE_D = `M ${MID - 26} ${T} H ${T + R} A ${R} ${R} 0 0 0 ${T + R} ${H - T} H ${MID - 12}`;
const RED_D = `M ${MID + 12} ${T} H ${CAP_W - T - R} A ${R} ${R} 0 0 1 ${CAP_W - T - R} ${H - T} H ${MID + 26}`;
const LINE_LEN = 2 * (MID - T - R) - 38 + Math.PI * R + 1; // both straight runs + the arc, +1 so no gap remains
const O_R = H / 2 - SW - SW / 2; // O's outer edge just touches the capsule's inner edge
const O_LEN = 2 * Math.PI * O_R;

// tagline
const TAG = 'CODE ANYWHERE';
const TFS = 0.024;
const TRACK = 6;
const WORD_GAP = 23;
const TAG_Y = H + 36;
const TAG_H = 24; // box for the glyphs (cap ≈ 17)
const TAG_BASE = 20;
const tagLetters = (() => {
  const out: { ch: string; x: number; w: number }[] = [];
  let x = 0;
  for (const ch of TAG) {
    if (ch === ' ') {
      x += WORD_GAP - TRACK;
      continue;
    }
    const w = LIGHT[ch].adv * TFS;
    out.push({ ch, x, w });
    x += w + TRACK;
  }
  const total = x - TRACK;
  const off = (W - total) / 2;
  return { letters: out.map((l) => ({ ...l, x: l.x + off })), total, off };
})();
const LINE_Y = TAG_Y + TAG_H + 12;
export const LOGO_ASPECT = (LINE_Y + 4) / W;

const APath = Animated.createAnimatedComponent(Path);
const ACircle = Animated.createAnimatedComponent(Circle);

/** One glyph, drawn at the wordmark's baseline. */
function Glyph({ d, adv, scale, s, height, base, color }: { d: string; adv: number; scale: number; s: number; height: number; base: number; color: string }) {
  return (
    <Svg width={adv * scale * s} height={height * s} viewBox={`0 ${-base / scale} ${adv} ${height / scale}`}>
      <Path d={d} fill={color} />
    </Svg>
  );
}

export function Logo({
  width,
  color,
  tagColor,
  tagline = true,
  animated = false,
  onDone,
}: {
  width: number;
  color: string;
  tagColor?: string;
  /** false = just the wordmark (e.g. in a header). */
  tagline?: boolean;
  animated?: boolean;
  onDone?: () => void;
}) {
  const s = width / W;
  const start = animated ? 0 : 1;
  const ni = useSharedValue(start);
  const lines = useSharedValue(start);
  const o = useSharedValue(start);
  const oPop = useSharedValue(1);
  const e = useSharedValue(start);
  const tag = useSharedValue(start);
  const rule = useSharedValue(start);

  useEffect(() => {
    if (!animated) return;
    const out = Easing.out(Easing.cubic);
    ni.set(withDelay(250, withTiming(1, { duration: 650, easing: Easing.inOut(Easing.cubic) })));
    lines.set(withDelay(450, withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) })));
    o.set(withDelay(800, withTiming(1, { duration: 500, easing: out })));
    oPop.set(withDelay(1250, withSequence(withTiming(1.12, { duration: 140 }), withSpring(1, { damping: 8, stiffness: 180 }))));
    e.set(withDelay(1050, withTiming(1, { duration: 450, easing: out })));
    tag.set(withDelay(1350, withTiming(1, { duration: 750, easing: Easing.linear })));
    rule.set(withDelay(1700, withTiming(1, { duration: 600, easing: out })));
    if (onDone) {
      const t = setTimeout(onDone, 2500);
      return () => clearTimeout(t);
    }
  }, [animated, ni, lines, o, oPop, e, tag, rule, onDone]);

  // "Ni" starts centred on the whole logo, a bit larger (matching the launch icon), then glides into place.
  const dx = (W / 2 - CAP_X / 2) * s;
  const dy = ((LOGO_ASPECT * W) / 2 - H / 2) * s;
  const niStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(ni.value, [0, 1], [dx, 0]) },
      { translateY: interpolate(ni.value, [0, 1], [dy, 0]) },
      { scale: interpolate(ni.value, [0, 1], [1.35, 1]) },
    ],
  }));
  const lineProps = useAnimatedProps(() => ({
    strokeDashoffset: LINE_LEN * (1 - lines.value),
  }));
  const oProps = useAnimatedProps(() => ({
    strokeDashoffset: O_LEN * (1 - o.value),
  }));
  const capStyle = useAnimatedStyle(() => ({
    opacity: interpolate(lines.value, [0, 0.05], [0, 1], 'clamp'),
  }));
  const oStyle = useAnimatedStyle(() => ({
    transform: [{ scale: oPop.value }],
  }));
  const eStyle = useAnimatedStyle(() => ({
    opacity: e.value,
    transform: [{ translateX: interpolate(e.value, [0, 1], [-28 * s, 0]) }],
  }));
  const ruleL = useAnimatedStyle(() => ({
    transform: [{ scaleX: rule.value }],
    opacity: interpolate(rule.value, [0, 0.2, 1], [0, 1, 0.9]),
  }));

  const fg = color;
  const tg = tagColor ?? color;
  return (
    <View style={{ width, height: tagline ? W * LOGO_ASPECT * s : H * s }} accessible accessibilityRole="image" accessibilityLabel="niCode, code anywhere">
      <Animated.View style={[styles.abs, { left: N_X * s, flexDirection: 'row' }, niStyle]}>
        <Glyph d={BOLD.N.d} adv={BOLD.N.adv} scale={FS} s={s} height={H} base={BASE} color={fg} />
        <Glyph d={BOLD.i.d} adv={BOLD.i.adv} scale={FS} s={s} height={H} base={BASE} color={fg} />
      </Animated.View>

      <Animated.View style={[styles.abs, { left: E_X * s }, eStyle]}>
        <Glyph d={BOLD.e.d} adv={BOLD.e.adv} scale={FS} s={s} height={H} base={BASE} color={fg} />
      </Animated.View>

      <Animated.View style={[styles.abs, { left: CAP_X * s }, capStyle]}>
        <Svg width={CAP_W * s} height={H * s} viewBox={`0 0 ${CAP_W} ${H}`}>
          <APath d={BLUE_D} stroke={BLUE} strokeWidth={SW} fill="none" strokeDasharray={[LINE_LEN, LINE_LEN]} animatedProps={lineProps} />
          <APath d={RED_D} stroke={RED} strokeWidth={SW} fill="none" strokeDasharray={[LINE_LEN, LINE_LEN]} animatedProps={lineProps} />
        </Svg>
      </Animated.View>
      <Animated.View style={[styles.abs, { left: CAP_X * s }, oStyle]}>
        <Svg width={CAP_W * s} height={H * s} viewBox={`0 0 ${CAP_W} ${H}`}>
          <ACircle
            cx={MID}
            cy={H / 2}
            r={O_R}
            stroke={fg}
            strokeWidth={SW}
            fill="none"
            strokeDasharray={[O_LEN, O_LEN]}
            animatedProps={oProps}
            rotation={-90}
            origin={`${MID}, ${H / 2}`}
          />
        </Svg>
      </Animated.View>

      {tagline && tagLetters.letters.map((l, i) => <TagLetter key={i} index={i} count={tagLetters.letters.length} progress={tag} x={l.x} ch={l.ch} s={s} color={tg} />)}

      {tagline ? (
        <View
          style={[
            styles.abs,
            {
              top: LINE_Y * s,
              left: tagLetters.off * s,
              width: tagLetters.total * s,
              height: Math.max(1.5, 2 * s),
              flexDirection: 'row',
            },
          ]}
        >
          <Animated.View style={[{ flex: 1, backgroundColor: BLUE, transformOrigin: 'right' }, ruleL]} />
          <Animated.View style={[{ flex: 1, backgroundColor: RED, transformOrigin: 'left' }, ruleL]} />
        </View>
      ) : null}
    </View>
  );
}

function TagLetter({ index, count, progress, x, ch, s, color }: { index: number; count: number; progress: SharedValue<number>; x: number; ch: string; s: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const from = (index / count) * 0.6;
    const p = interpolate(progress.value, [from, from + 0.4], [0, 1], 'clamp');
    return { opacity: p, transform: [{ translateY: (1 - p) * 10 * s }] };
  });
  return (
    <Animated.View style={[styles.abs, { left: x * s, top: TAG_Y * s }, style]}>
      <Glyph d={LIGHT[ch].d} adv={LIGHT[ch].adv} scale={TFS} s={s} height={TAG_H} base={TAG_BASE} color={color} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute', top: 0 },
});
