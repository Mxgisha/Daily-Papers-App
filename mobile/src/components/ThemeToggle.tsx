import { Pressable, Text } from 'react-native';

import { useTheme } from '../theme';

/**
 * The theme toggle.
 *
 * Its own component, subscribing to the theme context directly, rather than a closure inside
 * `screenOptions`. React Navigation memoises header options, so an inline `headerRight` can
 * keep rendering with a stale captured value even after the theme changes.
 */
export function ThemeToggle() {
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
