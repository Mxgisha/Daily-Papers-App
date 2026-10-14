import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ThemeToggle } from '../src/components/ThemeToggle';
import { AppDrawer, DrawerButton, DrawerProvider } from '../src/drawer';
import { LibraryProvider } from '../src/library';
import { ThemeProvider, useTheme } from '../src/theme';

/**
 * The nav bar follows the app theme, including its background.
 *
 * The native header takes its appearance from the platform as well as from these options, so
 * `ThemeProvider` also calls `Appearance.setColorScheme` — see src/theme.tsx.
 *
 * The reader is a pushed screen and keeps the default back button; the three list screens get
 * the drawer control instead, since there is nothing to go back to from them.
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
          headerLeft: () => <DrawerButton />,
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Papers' }} />
        <Stack.Screen name="saved" options={{ title: 'Saved' }} />
        <Stack.Screen name="history" options={{ title: 'History' }} />
        <Stack.Screen name="read/[id]" options={{ title: 'Reading' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <LibraryProvider>
        <DrawerProvider>
          {/* The drawer is a sibling of the navigator, not part of it, so it can overlay any
              screen — including the reader, which covers everything else. */}
          <RootStack />
          <AppDrawer />
        </DrawerProvider>
      </LibraryProvider>
    </ThemeProvider>
  );
}
