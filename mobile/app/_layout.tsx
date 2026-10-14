import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text } from 'react-native';

import { ThemeProvider, useTheme } from '../src/theme';

/**
 * The theme toggle.
 *
 * Its own component, subscribing to the theme context directly, rather than a closure inside
 * `screenOptions`. React Navigation memoises header options, so an inline `headerRight` can
 * keep rendering with a stale captured value even after the theme changes — which is part of
 * why the bar did not follow light mode. A component that subscribes re-renders on its own.
 */
function ThemeToggle() {
  const { palette, isDark, toggle } = useTheme();
  return (
    <Pressable
      onPress={toggle}
      testID="theme-toggle"
      accessibilityRole="button"
      accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      hitSlop={12}
      style={{ paddingHorizontal: 10, paddingVertical: 4 }}
    >
      <Text style={{ color: palette.accent, fontSize: 15, fontWeight: '600' }}>
        {isDark ? 'Light' : 'Dark'}
      </Text>
    </Pressable>
  );
}

/**
 * The nav bar follows the app theme, including its background.
 *
 * Previously these colours were hardcoded dark, so switching the app to light mode left a
 * black bar across the top. The native header takes its appearance from the platform as well
 * as from these options, so `ThemeProvider` also calls `Appearance.setColorScheme` — see
 * src/theme.tsx.
 */
function ThemedStack() {
  const { palette, isDark } = useTheme();

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.headerBg },
          headerTintColor: palette.headerText,
          headerTitleStyle: { color: palette.headerText },
          contentStyle: { backgroundColor: palette.bg },
          headerRight: () => <ThemeToggle />,
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Papers' }} />
        <Stack.Screen name="read/[id]" options={{ title: 'Reading' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ThemedStack />
    </ThemeProvider>
  );
}
