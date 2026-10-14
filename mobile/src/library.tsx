/**
 * Library: saved papers, reading positions, and a cache of paper metadata.
 *
 * Everything lives on the device. There is no account and no server, so AsyncStorage is the
 * whole store.
 *
 * Three things, and the third exists because of a bug:
 *
 *  - **Saved papers** carry their own metadata rather than just an id. A paper reached
 *    through arXiv search is not in the bundled list, so an id alone would give the Saved
 *    tab nothing to render without a network round trip.
 *  - **Reading positions** are stored as a fraction of the document *plus* an anchor: the
 *    index of the topmost visible block element. The fraction alone drifts whenever the
 *    document changes height — which lazy figures do constantly — so the anchor is what
 *    actually makes restore reliable.
 *  - **Known papers** caches metadata for anything that has been on screen. The reader can be
 *    opened cold, from a pasted id or the paper of the day, with no list entry behind it; it
 *    used to save such a paper with the arXiv id as its title, which is why saved search
 *    results showed up as "2610.14091".
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

import type { PaperItem } from './types';

const FAVORITES_KEY = 'dailypapers:favorites:v1';
const POSITIONS_KEY = 'dailypapers:positions:v2';
const KNOWN_KEY = 'dailypapers:known:v1';
/** v1 stored a bare number; read for continuity, written to v2. */
const POSITIONS_KEY_V1 = 'dailypapers:positions:v1';

/** Bounds so none of these grow without limit on a device that is used for years. */
const MAX_POSITIONS = 500;
const MAX_KNOWN = 400;

export interface SavedPaper {
  id: string;
  title: string;
  category: string;
  published: string | null;
  authors: string[];
  abstract: string;
  savedAt: number;
}

/** Where the reader was: how far through, and which block was at the top. */
export interface ReadingSpot {
  fraction: number;
  /** Index into the document's block elements, or -1 when unknown. */
  anchor: number;
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

/** Accept both the current shape and the v1 bare number. */
function normaliseSpot(value: unknown): ReadingSpot | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { fraction: value, anchor: -1 };
  }
  if (value && typeof value === 'object') {
    const v = value as { fraction?: unknown; anchor?: unknown };
    if (typeof v.fraction === 'number' && Number.isFinite(v.fraction)) {
      return {
        fraction: v.fraction,
        anchor: typeof v.anchor === 'number' ? v.anchor : -1,
      };
    }
  }
  return null;
}

interface LibraryValue {
  ready: boolean;
  /** Most recently saved first. */
  favorites: SavedPaper[];
  isFavorite: (id: string) => boolean;
  toggleFavorite: (paper: Omit<SavedPaper, 'savedAt'>) => void;
  /** Where the reader was, or null if never opened. */
  positionFor: (id: string) => ReadingSpot | null;
  rememberPosition: (id: string, spot: ReadingSpot) => void;
  forgetPosition: (id: string) => void;
  /** Cached metadata for anything that has been on screen, so a cold open still has a title. */
  paperMeta: (id: string) => PaperItem | null;
  rememberPaper: (paper: PaperItem) => void;
}

const LibraryContext = createContext<LibraryValue>({
  ready: false,
  favorites: [],
  isFavorite: () => false,
  toggleFavorite: () => {},
  positionFor: () => null,
  rememberPosition: () => {},
  forgetPosition: () => {},
  paperMeta: () => null,
  rememberPaper: () => {},
});

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [favorites, setFavorites] = useState<SavedPaper[]>([]);
  const positions = useRef<Record<string, ReadingSpot>>({});
  const known = useRef<Record<string, PaperItem>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const [favs, v2, v1, kn] = await Promise.all([
        readJson<SavedPaper[]>(FAVORITES_KEY, []),
        readJson<Record<string, unknown>>(POSITIONS_KEY, {}),
        readJson<Record<string, unknown>>(POSITIONS_KEY_V1, {}),
        readJson<Record<string, PaperItem>>(KNOWN_KEY, {}),
      ]);
      if (!alive) return;

      setFavorites(Array.isArray(favs) ? favs : []);

      const merged: Record<string, ReadingSpot> = {};
      for (const source of [v1, v2]) {
        if (!source || typeof source !== 'object') continue;
        for (const [id, value] of Object.entries(source)) {
          const spot = normaliseSpot(value);
          if (spot) merged[id] = spot;
        }
      }
      positions.current = merged;
      known.current = kn && typeof kn === 'object' ? kn : {};
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

  // Writes are debounced: the reader reports scroll continuously, and for the PDF renderer
  // that means every page boundary too.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      void writeJson(POSITIONS_KEY, positions.current);
    }, 1200);
  }, []);

  const trim = <T,>(map: Record<string, T>, max: number) => {
    const keys = Object.keys(map);
    if (keys.length > max) {
      // Object key order is insertion order, so the earliest entries go first.
      for (const stale of keys.slice(0, keys.length - max)) delete map[stale];
    }
  };

  const rememberPosition = useCallback(
    (id: string, spot: ReadingSpot) => {
      const fraction = Number.isFinite(spot.fraction)
        ? Math.min(Math.max(spot.fraction, 0), 1)
        : 0;
      positions.current[id] = { fraction, anchor: spot.anchor };
      trim(positions.current, MAX_POSITIONS);
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

  const positionFor = useCallback((id: string) => positions.current[id] ?? null, []);

  // Persisted separately from positions and flushed immediately: this is what makes a title
  // available the next time the same paper is opened cold.
  const rememberPaper = useCallback((paper: PaperItem) => {
    const existing = known.current[paper.id];
    if (existing && existing.title === paper.title && existing.category === paper.category) {
      return;
    }
    known.current[paper.id] = paper;
    trim(known.current, MAX_KNOWN);
    void writeJson(KNOWN_KEY, known.current);
  }, []);

  const paperMeta = useCallback((id: string) => known.current[id] ?? null, []);

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
      paperMeta,
      rememberPaper,
    }),
    [
      ready,
      favorites,
      isFavorite,
      toggleFavorite,
      positionFor,
      rememberPosition,
      forgetPosition,
      paperMeta,
      rememberPaper,
    ],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  return useContext(LibraryContext);
}
