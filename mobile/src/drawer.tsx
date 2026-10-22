/**
 * The left navigation drawer.
 *
 * Hand-rolled rather than pulled from @react-navigation/drawer, which would bring
 * react-native-gesture-handler and react-native-reanimated with it. Those have fought the
 * rest of the dependency tree before (the worklets peer conflict), and the whole point of
 * this app's stack is that it runs in Expo Go with no native surprises. A panel animated with
 * React Native's own Animated API does everything needed here.
 *
 * It is an overlay rendered above the navigator rather than part of the navigation tree, so
 * it can be opened from any screen — including the reader, which otherwise hides everything.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLibrary } from './library';
import { useTheme, type Palette } from './theme';

const PANEL_WIDTH = Math.min(300, Dimensions.get('window').width * 0.8);
const DURATION = 220;

interface DrawerValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useDrawer(): DrawerValue {
  return useContext(DrawerContext);
}

/** The header control. Lives on the left, where a drawer is expected to be. */
export function DrawerButton() {
  const { palette } = useTheme();
  const { open } = useDrawer();
  return (
    <Pressable
      onPress={open}
      testID="drawer-open"
      accessibilityRole="button"
      accessibilityLabel="Open navigation"
      hitSlop={12}
      style={{ paddingHorizontal: 12, paddingVertical: 4 }}
    >
      <Text style={{ color: palette.accent, fontSize: 22, lineHeight: 24 }}>☰</Text>
    </Pressable>
  );
}

interface Destination {
  href: string;
  label: string;
  glyph: string;
}

const DESTINATIONS: Destination[] = [
  { href: '/', label: 'Papers', glyph: '▤' },
  { href: '/saved', label: 'Saved', glyph: '★' },
  { href: '/history', label: 'History', glyph: '◷' },
  { href: '/settings', label: 'Settings', glyph: '⚙' },
];

export function AppDrawer() {
  const { palette } = useTheme();
  const { isOpen, close } = useDrawer();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { favorites, history } = useLibrary();

  const progress = useRef(new Animated.Value(0)).current;
  // Kept mounted while closing so the panel can animate out; `visible` drives the animation
  // and `mounted` is what actually removes it from the tree.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: isOpen ? 1 : 0,
      duration: DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !isOpen) setMounted(false);
    });
    return () => animation.stop();
  }, [isOpen, progress]);

  // Android's hardware back should close the drawer rather than leave the screen.
  useEffect(() => {
    if (!isOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [isOpen, close]);

  const styles2 = useMemo(() => makeStyles(palette), [palette]);

  const counts: Record<string, number> = {
    '/saved': favorites.length,
    '/history': history.length,
  };

  if (!mounted) return null;

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-PANEL_WIDTH, 0],
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={isOpen ? 'auto' : 'none'}>
      <Animated.View style={[styles2.backdrop, { opacity: progress }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close navigation"
        />
      </Animated.View>

      <Animated.View
        style={[
          styles2.panel,
          { width: PANEL_WIDTH, paddingTop: insets.top + 18, transform: [{ translateX }] },
        ]}
      >
        <Text style={styles2.brand}>Daily Papers</Text>

        {DESTINATIONS.map((d) => {
          // `/` must match exactly, or every route looks active.
          const active = d.href === '/' ? pathname === '/' : pathname.startsWith(d.href);
          const count = counts[d.href];
          return (
            <Pressable
              key={d.href}
              testID={`drawer-${d.label.toLowerCase()}`}
              onPress={() => {
                close();
                router.navigate(d.href as never);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles2.item, active && styles2.itemActive]}
            >
              <Text style={[styles2.glyph, active && styles2.itemTextActive]}>{d.glyph}</Text>
              <Text style={[styles2.itemText, active && styles2.itemTextActive]}>{d.label}</Text>
              {count !== undefined && count > 0 && (
                <Text style={styles2.count}>{count}</Text>
              )}
            </Pressable>
          );
        })}

        <View style={styles2.spacer} />
        <ThemeRow />
        <Text style={[styles2.footer, { color: palette.dim }]}>
          Reading, kept on this device.
        </Text>
      </Animated.View>
    </View>
  );
}

function ThemeRow() {
  const { palette, isDark, toggle } = useTheme();
  const styles2 = useMemo(() => makeStyles(palette), [palette]);
  return (
    <Pressable
      onPress={toggle}
      testID="drawer-theme"
      accessibilityRole="button"
      accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      style={styles2.item}
    >
      <Text style={styles2.glyph}>{isDark ? '☀' : '☾'}</Text>
      <Text style={styles2.itemText}>{isDark ? 'Light mode' : 'Dark mode'}</Text>
    </Pressable>
  );
}

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    panel: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      backgroundColor: p.headerBg,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: p.border,
      paddingHorizontal: 10,
    },
    brand: {
      color: p.text,
      fontSize: 19,
      fontWeight: '700',
      paddingHorizontal: 10,
      paddingBottom: 16,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 10,
      paddingVertical: 13,
      borderRadius: 8,
    },
    itemActive: { backgroundColor: p.inputBg },
    glyph: { fontSize: 17, color: p.dim, width: 22, textAlign: 'center' },
    itemText: { color: p.text, fontSize: 15.5, flex: 1 },
    itemTextActive: { color: p.accent, fontWeight: '600' },
    count: { color: p.dim, fontSize: 12.5 },
    spacer: { flex: 1 },
    footer: { fontSize: 11, paddingHorizontal: 10, paddingVertical: 14 },
  });
