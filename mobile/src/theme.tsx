/**
 * App theme.
 *
 * Two explicit themes, light and dark, chosen by the user. There is deliberately no "auto"
 * option and no `prefers-color-scheme` anywhere: the reader stylesheet used to follow the
 * system, which meant the article could disagree with the app chrome around it. Now the app
 * owns the theme and passes it down, including into the WebView.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Appearance } from 'react-native';

export type ThemeName = 'light' | 'dark';

export interface Palette {
  bg: string;
  card: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  inputBg: string;
  headerBg: string;
  headerText: string;
  chipBg: string;
  chipActiveBg: string;
  chipActiveText: string;
}

const LIGHT: Palette = {
  bg: '#ffffff',
  card: '#ffffff',
  border: '#e3e5e8',
  text: '#1a1a1a',
  dim: '#5f6570',
  accent: '#1a5fb4',
  inputBg: '#f5f6f8',
  headerBg: '#ffffff',
  headerText: '#1a1a1a',
  chipBg: '#f0f1f3',
  chipActiveBg: '#1a5fb4',
  chipActiveText: '#ffffff',
};

const DARK: Palette = {
  bg: '#16181c',
  card: '#16181c',
  border: '#2b2f36',
  text: '#e6e6e6',
  dim: '#8b9199',
  accent: '#8ab4f8',
  inputBg: '#1e2126',
  headerBg: '#16181c',
  headerText: '#e6e6e6',
  chipBg: '#1e2126',
  chipActiveBg: '#2f4a66',
  chipActiveText: '#cfe3ff',
};

export const PALETTES: Record<ThemeName, Palette> = { light: LIGHT, dark: DARK };

interface ThemeContextValue {
  theme: ThemeName;
  palette: Palette;
  toggle: () => void;
  setTheme: (t: ThemeName) => void;
  /** Passed straight into the WebView as `data-theme`. */
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  palette: DARK,
  toggle: () => {},
  setTheme: () => {},
  isDark: true,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>('dark');

  /**
   * Tell the platform which scheme we are in.
   *
   * This is the fix for the nav bar not following light mode. The Stack header is a NATIVE
   * header (react-native-screens) and takes its appearance from the platform, not purely
   * from `headerStyle` — so it kept rendering the system appearance and stayed dark while
   * the rest of the app went light.
   *
   * `Appearance.setColorScheme` overrides the system scheme for the whole app, which is
   * exactly what "only white or black, no auto" means.
   */
  useEffect(() => {
    // Not available on every platform -- react-native-web does not implement it, and an
    // unguarded call threw during mount and blanked the whole app. The header colours still
    // come from the palette on those platforms, so the theme is merely less forceful.
    try {
      if (typeof Appearance?.setColorScheme === 'function') {
        Appearance.setColorScheme(theme);
      }
    } catch {
      /* platform does not support forcing a scheme; palette colours still apply */
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      palette: PALETTES[theme],
      isDark: theme === 'dark',
      toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      setTheme,
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
