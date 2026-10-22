/**
 * Device preferences: reading text size and the daily reminder.
 *
 * Apart from the library on purpose. The library holds *records* — papers saved, read, or
 * positioned — which the user creates by using the app. These are *settings*, created by
 * choosing, and they change how the app behaves rather than what it remembers. Keeping them
 * separate also keeps the library from growing into an object that does everything.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

const KEY = 'dailypapers:settings:v1';

/** Body text sizes offered by the Aa control. 18px is the stylesheet's own default. */
export const TEXT_SIZES = [16, 18, 21] as const;
export const TEXT_SIZE_LABELS = ['Small', 'Default', 'Large'] as const;
const DEFAULT_SCALE = 1;

export interface Settings {
  /** Index into TEXT_SIZES. */
  textScale: number;
  /** Hour 0-23 for the daily reminder, or null when it is off. */
  reminderHour: number | null;
}

const DEFAULTS: Settings = { textScale: DEFAULT_SCALE, reminderHour: null };

interface SettingsValue extends Settings {
  ready: boolean;
  /** The value to hand the reader, in px. */
  textSizePx: number;
  setTextScale: (index: number) => void;
  /** Small → Default → Large → Small. */
  cycleTextScale: () => void;
  setReminderHour: (hour: number | null) => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

function clampScale(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= TEXT_SIZES.length) {
    return DEFAULT_SCALE;
  }
  return index;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (!alive) return;
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<Settings>;
          setSettings({
            textScale: clampScale(parsed.textScale ?? DEFAULT_SCALE),
            reminderHour:
              typeof parsed.reminderHour === 'number' &&
              parsed.reminderHour >= 0 &&
              parsed.reminderHour <= 23
                ? parsed.reminderHour
                : null,
          });
        }
      } catch {
        // A corrupt settings blob must not stop the app; the defaults are fine.
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void AsyncStorage.setItem(KEY, JSON.stringify(settings)).catch(() => {});
  }, [settings, ready]);

  const setTextScale = useCallback((index: number) => {
    setSettings((s) => ({ ...s, textScale: clampScale(index) }));
  }, []);

  const cycleTextScale = useCallback(() => {
    setSettings((s) => ({ ...s, textScale: (s.textScale + 1) % TEXT_SIZES.length }));
  }, []);

  const setReminderHour = useCallback((hour: number | null) => {
    setSettings((s) => ({ ...s, reminderHour: hour }));
  }, []);

  const value = useMemo<SettingsValue>(
    () => ({
      ...settings,
      ready,
      textSizePx: TEXT_SIZES[clampScale(settings.textScale)] ?? TEXT_SIZES[DEFAULT_SCALE],
      setTextScale,
      cycleTextScale,
      setReminderHour,
    }),
    [settings, ready, setTextScale, cycleTextScale, setReminderHour],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside a SettingsProvider');
  return value;
}
