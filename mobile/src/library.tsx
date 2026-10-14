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
 *    document changes height — which lazy figures do constantly.
 *  - **Known papers** caches metadata for anything that has been on screen, and `updateFavorite`
 *    repairs saved entries whose metadata was not known at the moment they were saved. That
 *    happens on a cold open, and when the star is tapped before the arXiv lookup returns.
 *    Toggling such an entry would simply delete it, so it is healed in place instead.
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

/** Bounds so none of these grow without limit on a device used for years. */
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

/** True when a saved entry is missing the metadata that makes it readable in a list. */
export function needsRepair(paper: SavedPaper): boolean {
  return paper.title.trim() === paper.id || paper.abstract.trim().length === 0;
}

/**
 * True when a paper's metadata is worth caching.
 *
 * A paper whose title is its id, or which has no abstract, is a placeholder rather than
 * information — caching it would poison the repair path. See `rememberPaper`.
 */
export function isUsefulMeta(paper: {
  id: string;
  title: string;
  abstract: string;
}): boolean {
  return paper.title.trim() !== paper.id && paper.abstract.trim().length > 0;
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
      return { fraction: v.fraction, anchor: typeof v.anchor === 'number' ? v.anchor : -1 };
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
  /** Merge metadata into an existing saved entry. A repair path, not a feature. */
  updateFavorite: (id: string, patch: Partial<Omit<SavedPaper, 'id' | 'savedAt'>>) => void;
  /** Where the reader was, or null if never opened. */
  positionFor: (id: string) => ReadingSpot | null;
  rememberPosition: (id: string, spot: ReadingSpot) => void;
  forgetPosition: (id: string) => void;
  /** Cached metadata for anything that has been on screen. */
  paperMeta: (id: string) => PaperItem | null;
  rememberPaper: (paper: PaperItem) => void;
}

const LibraryContext = createContext<LibraryValue>({
  ready: false,
  favorites: [],
  isFavorite: () => false,
  toggleFavorite: () => {},
  updateFavorite: () => {},
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

  // Persisted by an effect rather than inside the state updater: a side effect in an updater
  // runs twice under StrictMode and is a trap in general.
  useEffect(() => {
    if (!ready) return;
    void writeJson(FAVORITES_KEY, favorites);
  }, [favorites, ready]);

  const isFavorite = useCallback(
    (id: string) => favorites.some((f) => f.id === id),
    [favorites],
  );

  const toggleFavorite = useCallback((paper: Omit<SavedPaper, 'savedAt'>) => {
    setFavorites((current) => {
      const exists = current.some((f) => f.id === paper.id);
      return exists
        ? current.filter((f) => f.id !== paper.id)
        : [{ ...paper, savedAt: Date.now() }, ...current];
    });
  }, []);

  const updateFavorite = useCallback(
    (id: string, patch: Partial<Omit<SavedPaper, 'id' | 'savedAt'>>) => {
      setFavorites((current) => {
        const index = current.findIndex((f) => f.id === id);
        if (index === -1) return current;
        const before = current[index];
        const merged = { ...before, ...patch };
        const unchanged =
          merged.title === before.title &&
          merged.abstract === before.abstract &&
          merged.category === before.category &&
          merged.authors.length === before.authors.length &&
          merged.published === before.published;
        if (unchanged) return current;
        const next = [...current];
        next[index] = merged;
        return next;
      });
    },
    [],
  );

  // Writes are debounced: the reader reports scroll continuously.
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

  // Written immediately rather than debounced: this is what makes a title available the next
  // time the same paper is opened cold.
  //
  // It refuses to cache metadata that is missing its details, and that guard is load-bearing.
  // The Saved tab renders the same PaperCard as everywhere else, so a broken saved entry
  // registers itself here — and the repair path would then read back the very thing it was
  // meant to fix and treat it as authoritative. That is how "saved from search shows the id"
  // survived two rounds of fixes: the repair found a cache hit, decided there was nothing to
  // do, and stopped. Because this cache is persisted, the poisoned entry outlived restarts.
  const rememberPaper = useCallback((paper: PaperItem) => {
    if (!isUsefulMeta(paper)) return;
    const existing = known.current[paper.id];
    if (existing && existing.title === paper.title && existing.abstract === paper.abstract) {
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
      updateFavorite,
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
      updateFavorite,
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
