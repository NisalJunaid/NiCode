import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Logo } from './Logo';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Plays the logo intro over the app on launch (black, like the native splash), then fades away. Tap to skip. */
export function AnimatedSplash() {
  const { width } = useWindowDimensions();
  const [gone, setGone] = useState(false);
  const fade = useSharedValue(1);

  const finish = useCallback(() => {
    fade.set(withTiming(0, { duration: 350 }, (done) => {
      if (done) runOnJS(setGone)(true);
    }));
  }, [fade]);
  const style = useAnimatedStyle(() => ({ opacity: fade.value, transform: [{ scale: 1 + (1 - fade.value) * 0.06 }] }));

  if (gone) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, style]} onLayout={() => void SplashScreen.hideAsync().catch(() => {})}>
      <Pressable style={styles.center} onPress={finish} accessibilityLabel="Skip intro">
        <Logo width={Math.min(width * 0.72, 340)} color="#FFFFFF" tagColor="#9AA0AA" animated onDone={finish} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000000', zIndex: 100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
