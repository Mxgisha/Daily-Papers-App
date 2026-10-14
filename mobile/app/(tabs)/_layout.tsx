import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';

import { ThemeToggle } from '../../src/components/ThemeToggle';
import { useLibrary } from '../../src/library';
import { useTheme } from '../../src/theme';

/** Glyph tab icons: no icon font dependency, and they render the same everywhere. */
function TabGlyph({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{glyph}</Text>;
}

export default function TabsLayout() {
  const { palette } = useTheme();
  const { favorites } = useLibrary();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: palette.headerBg },
        headerTintColor: palette.headerText,
        headerTitleStyle: { color: palette.headerText },
        headerRight: () => <ThemeToggle />,
        tabBarStyle: { backgroundColor: palette.headerBg, borderTopColor: palette.border },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.dim,
        sceneStyle: { backgroundColor: palette.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Papers',
          tabBarIcon: ({ color }) => <TabGlyph glyph="▤" color={color} />,
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          // The count makes the tab useful at a glance; no badge library needed.
          title: favorites.length > 0 ? `Saved (${favorites.length})` : 'Saved',
          tabBarIcon: ({ color }) => <TabGlyph glyph="★" color={color} />,
        }}
      />
    </Tabs>
  );
}
