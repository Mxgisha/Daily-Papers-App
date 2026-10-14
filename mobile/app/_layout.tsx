import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ThemeToggle } from '../src/components/ThemeToggle';
import { LibraryProvider } from '../src/library';
import { ThemeProvider, useTheme } from '../src/theme';

/**
 * The nav bar follows the app theme, including its background.
 *
 * The native header takes its appearance from the platform as well as from these options, so
 * `ThemeProvider` also calls `Appearance.setColorScheme` — see src/theme.tsx.
 *
 * The reader sits outside the tab group so it opens full screen, without a tab bar beneath.
 */
function RootStack() {
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
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="read/[id]" options={{ title: 'Reading' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <LibraryProvider>
        <RootStack />
      </LibraryProvider>
    </ThemeProvider>
  );
}
