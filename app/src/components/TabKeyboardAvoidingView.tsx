import type { ReactNode } from 'react';
import { useContext } from 'react';
import type { ViewStyle } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
// expo-router bundles React Navigation's bottom tabs but doesn't re-export this context publicly.
import { BottomTabBarHeightContext } from 'expo-router/build/react-navigation/bottom-tabs';

/**
 * Keeps inputs above the keyboard on screens inside the bottom tabs. The tab bar sits below
 * the screen; the library measures the screen relative to the tab scene, so it under-shoots by
 * exactly the tab bar height. Passing it as the offset lifts inputs fully above the keyboard.
 * (Measured on Android 14, edge-to-edge: without this the composer stays under the keyboard.)
 */
export function TabKeyboardAvoidingView({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={tabBarHeight} style={[{ flex: 1 }, style]}>
      {children}
    </KeyboardAvoidingView>
  );
}
