/**
 * Library: saved papers and reading positions.
 *
 * Both live on the device. There is no account and no server, so AsyncStorage is the whole
 * store — a JSON array of saved papers and a JSON map of positions.
 *
 * Saved papers carry their own metadata rather than just an id. A paper reached through
 * arXiv search is not in the bundled list, so storing the id alone would give the Favorites
 * tab nothing to render without a network round trip.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
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

const FAVORITES_KEY = 'dailypapers:favorites:v1';
const POSITIONS_KEY = 'dailypapers:positions:v1';

/** Positions beyond this are dropped oldest-first; the map would otherwise grow forever. */
const MAX_POSITIONS = 500;

export interface SavedPaper {
  id: string;
  title: string;
  category: string;
  published: string | null;
  authors: string[];
  abstract: string;
  savedAt: number;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage failures must never break reading. Losing a bookmark is not worth a crash.
  }
}

interface LibraryValue {
  ready: boolean;
  /** Most recently saved first. */
  favorites: SavedPaper[];
  isFavorite: (id: string) => boolean;
  toggleFavorite: (paper: Omit<SavedPaper, 'savedAt'>) => void;
  /** 0..1 through the document, or null if never opened. */
  positionFor: (id: string) => number | null;
  rememberPosition: (id: string, fraction: number) => void;
  forgetPosition: (id: string) => void;
}

const LibraryContext = createContext<LibraryValue>({
  ready: false,
  favorites: [],
  isFavorite: () => false,
  toggleFavorite: () => {},
  positionFor: () => null,
  rememberPosition: () => {},
  forgetPosition: () => {},
});

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [favorites, setFavorites] = useState<SavedPaper[]>([]);
  const positions = useRef<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const [favs, pos] = await Promise.all([
        readJson<SavedPaper[]>(FAVORITES_KEY, []),
        readJson<Record<string, number>>(POSITIONS_KEY, {}),
      ]);
      if (!alive) return;
      setFavorites(Array.isArray(favs) ? favs : []);
      positions.current = pos && typeof pos === 'object' ? pos : {};
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const isFavorite = useCallback(
    (id: string) => favorites.some((f) => f.id === id),
    [favorites],
  );

  const toggleFavorite = useCallback((paper: Omit<SavedPaper, 'savedAt'>) => {
    setFavorites((current) => {
      const exists = current.some((f) => f.id === paper.id);
      const next = exists
        ? current.filter((f) => f.id !== paper.id)
        : [{ ...paper, savedAt: Date.now() }, ...current];
      void writeJson(FAVORITES_KEY, next);
      return next;
    });
  }, []);

  // Positions are written on a short debounce: the reader reports scroll continuously and
  // storing every event would hammer storage for no benefit.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      void writeJson(POSITIONS_KEY, positions.current);
    }, 1500);
  }, []);

  const rememberPosition = useCallback(
    (id: string, fraction: number) => {
      if (!Number.isFinite(fraction)) return;
      positions.current[id] = Math.min(Math.max(fraction, 0), 1);

      const keys = Object.keys(positions.current);
      if (keys.length > MAX_POSITIONS) {
        // Object key order is insertion order, so the earliest entries go first.
        for (const stale of keys.slice(0, keys.length - MAX_POSITIONS)) {
          delete positions.current[stale];
        }
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const forgetPosition = useCallback(
    (id: string) => {
      delete positions.current[id];
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const positionFor = useCallback((id: string) => {
    const v = positions.current[id];
    return typeof v === 'number' ? v : null;
  }, []);

  // Flush anything pending if the provider unmounts.
  useEffect(
    () => () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        void writeJson(POSITIONS_KEY, positions.current);
      }
    },
    [],
  );

  const value = useMemo<LibraryValue>(
    () => ({
      ready,
      favorites,
      isFavorite,
      toggleFavorite,
      positionFor,
      rememberPosition,
      forgetPosition,
    }),
    [ready, favorites, isFavorite, toggleFavorite, positionFor, rememberPosition, forgetPosition],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  return useContext(LibraryContext);
}
