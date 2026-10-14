/**
 * Library: saved papers, reading history, recent searches, and cached metadata.
 *
 * Everything lives on the device. There is no account and no server, so AsyncStorage is the
 * whole store.
 *
 * Four things, and the last two exist because of bugs found in use:
 *
 *  - **Saved papers** carry their own metadata rather than just an id, because a paper
 *    reached through arXiv search is not in the bundled list.
 *  - **Reading positions** are a fraction of the document plus an anchor: the index of the
 *    topmost visible block. The fraction alone drifts, because lazy figures keep growing the
 *    document after load.
 *  - **Known papers** caches metadata for anything that has been on screen. It refuses to
 *    cache a placeholder, and that guard is load-bearing — a broken saved entry once
 *    registered itself here, and the repair path then read back the very thing it was meant
 *    to fix and concluded there was nothing to do.
 *  - **History and recent searches** are plain records, but history shares the repair path,
 *    which is now in one place (src/useRepair.ts) rather than copied per screen.
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
const HISTORY_KEY = 'dailypapers:history:v1';
const SEARCHES_KEY = 'dailypapers:searches:v1';
const POSITIONS_KEY = 'dailypapers:positions:v2';
const KNOWN_KEY = 'dailypapers:known:v1';
/** v1 stored a bare number; read for continuity, written to v2. */
const POSITIONS_KEY_V1 = 'dailypapers:positions:v1';

/** Bounds so none of these grow without limit on a device used for years. */
const MAX_POSITIONS = 500;
const MAX_KNOWN = 400;
const MAX_HISTORY = 300;
export const MAX_RECENT_SEARCHES = 5;

export interface SavedPaper {
  id: string;
  title: string;
  category: string;
  published: string | null;
  authors: string[];
  abstract: string;
  savedAt: number;
}

/** A paper that has been opened. One entry per paper, updated in place. */
export interface HistoryEntry {
  id: string;
  title: string;
  category: string;
  published: string | null;
  authors: string[];
  abstract: string;
  /** When it was first opened. */
  openedAt: number;
  /** When it was last opened — the sort key. */
  lastOpenedAt: number;
  /** When the reader marked it finished, or null. */
  finishedAt: number | null;
}

/** Where the reader was: how far through, and which block was at the top. */
export interface ReadingSpot {
  fraction: number;
  anchor: number;
}

/**
 * True when stored metadata is missing the details that make it readable in a list.
 *
 * Deliberately takes the minimum shape rather than a `SavedPaper`: history entries need the
 * same test, and both are "a record that may have been written before its metadata was
 * known".
 */
export function needsRepair(paper: {
  id: string;
  title: string;
  abstract: string;
}): boolean {
  return paper.title.trim() === paper.id || paper.abstract.trim().length === 0;
}

/** The inverse, used to decide whether metadata is worth caching at all. */
export function isUsefulMeta(paper: {
  id: string;
  title: string;
  abstract: string;
}): boolean {
  return paper.title.trim() !== paper.id && paper.abstract.trim().length > 0;
}

/** Fields a repair fills in. Shared by saved papers and history. */
export interface MetaPatch {
  title: string;
  abstract: string;
  category: string;
  authors: string[];
  published: string | null;
}

/** Build a patch from a paper, or null if it is a placeholder rather than information. */
export function patchFromPaper(paper: PaperItem | null): MetaPatch | null {
  if (!paper || !isUsefulMeta(paper)) return null;
  return {
    title: paper.title,
    abstract: paper.abstract,
    category: paper.category,
    authors: paper.authors,
    published: paper.published,
  };
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

/** Keep only the most recent `max` entries of an insertion-ordered record. */
function trimRecord<T>(map: Record<string, T>, max: number): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  for (const stale of keys.slice(0, keys.length - max)) delete map[stale];
}

/** Case-insensitive de-duplication for search terms, newest first. */
function mergeSearch(terms: string[], term: string): string[] {
  const clean = term.trim();
  if (!clean) return terms;
  const without = terms.filter((t) => t.toLowerCase() !== clean.toLowerCase());
  return [clean, ...without].slice(0, MAX_RECENT_SEARCHES);
}

interface LibraryValue {
  ready: boolean;

  favorites: SavedPaper[];
  isFavorite: (id: string) => boolean;
  toggleFavorite: (paper: Omit<SavedPaper, 'savedAt'>) => void;
  /** Merge metadata into an existing saved entry. A repair path, not a feature. */
  updateFavorite: (id: string, patch: Partial<MetaPatch>) => void;

  /** Most recently opened first. */
  history: HistoryEntry[];
  recordOpen: (paper: PaperItem) => void;
  markFinished: (id: string, finished: boolean) => void;
  updateHistory: (id: string, patch: Partial<MetaPatch>) => void;
  forgetRead: (id: string) => void;

  /** Most recent first, at most MAX_RECENT_SEARCHES. */
  recentSearches: string[];
  rememberSearch: (term: string) => void;
  forgetSearch: (term: string) => void;
  clearSearches: () => void;

  positionFor: (id: string) => ReadingSpot | null;
  rememberPosition: (id: string, spot: ReadingSpot) => void;
  forgetPosition: (id: string) => void;

  paperMeta: (id: string) => PaperItem | null;
  rememberPaper: (paper: PaperItem) => void;
}

const LibraryContext = createContext<LibraryValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [favorites, setFavorites] = useState<SavedPaper[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const positions = useRef<Record<string, ReadingSpot>>({});
  const known = useRef<Record<string, PaperItem>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const [favs, hist, searches, posV2, posV1, kn] = await Promise.all([
        readJson<SavedPaper[]>(FAVORITES_KEY, []),
        readJson<HistoryEntry[]>(HISTORY_KEY, []),
        readJson<string[]>(SEARCHES_KEY, []),
        readJson<Record<string, unknown>>(POSITIONS_KEY, {}),
        readJson<Record<string, unknown>>(POSITIONS_KEY_V1, {}),
        readJson<Record<string, PaperItem>>(KNOWN_KEY, {}),
      ]);
      if (!alive) return;

      setFavorites(Array.isArray(favs) ? favs : []);
      setHistory(Array.isArray(hist) ? hist : []);
      setRecentSearches(
        Array.isArray(searches) ? searches.filter((s) => typeof s === 'string') : [],
      );

      const merged: Record<string, ReadingSpot> = {};
      for (const source of [posV1, posV2]) {
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

  // Persisted by effects rather than inside the state updaters: a side effect in an updater
  // runs twice under StrictMode and is a trap in general.
  useEffect(() => {
    if (ready) void writeJson(FAVORITES_KEY, favorites);
  }, [favorites, ready]);
  useEffect(() => {
    if (ready) void writeJson(HISTORY_KEY, history);
  }, [history, ready]);
  useEffect(() => {
    if (ready) void writeJson(SEARCHES_KEY, recentSearches);
  }, [recentSearches, ready]);

  // ---------------------------------------------------------------- favorites

  const isFavorite = useCallback(
    (id: string) => favorites.some((f) => f.id === id),
    [favorites],
  );

  const toggleFavorite = useCallback((paper: Omit<SavedPaper, 'savedAt'>) => {
    setFavorites((current) =>
      current.some((f) => f.id === paper.id)
        ? current.filter((f) => f.id !== paper.id)
        : [{ ...paper, savedAt: Date.now() }, ...current],
    );
  }, []);

  const updateFavorite = useCallback((id: string, patch: Partial<MetaPatch>) => {
    setFavorites((current) => {
      const index = current.findIndex((f) => f.id === id);
      if (index === -1) return current;
      const merged = { ...current[index], ...patch };
      if (shallowEqualMeta(current[index], merged)) return current;
      const next = [...current];
      next[index] = merged;
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- history

  const recordOpen = useCallback((paper: PaperItem) => {
    setHistory((current) => {
      const now = Date.now();
      const index = current.findIndex((h) => h.id === paper.id);
      const entry: HistoryEntry = {
        id: paper.id,
        // Prefer what we already stored: an open can happen with a placeholder title, and
        // overwriting a good record with a bad one is worse than doing nothing.
        title: isUsefulMeta(paper) ? paper.title : (current[index]?.title ?? paper.title),
        abstract: isUsefulMeta(paper)
          ? paper.abstract
          : (current[index]?.abstract ?? paper.abstract),
        category: paper.category || current[index]?.category || '',
        published: paper.published ?? current[index]?.published ?? null,
        authors: paper.authors.length ? paper.authors : (current[index]?.authors ?? []),
        openedAt: current[index]?.openedAt ?? now,
        lastOpenedAt: now,
        finishedAt: current[index]?.finishedAt ?? null,
      };
      const next = [entry, ...current.filter((h) => h.id !== paper.id)];
      return next.slice(0, MAX_HISTORY);
    });
  }, []);

  const markFinished = useCallback((id: string, finished: boolean) => {
    setHistory((current) =>
      current.map((h) =>
        h.id === id ? { ...h, finishedAt: finished ? Date.now() : null } : h,
      ),
    );
  }, []);

  const updateHistory = useCallback((id: string, patch: Partial<MetaPatch>) => {
    setHistory((current) => {
      const index = current.findIndex((h) => h.id === id);
      if (index === -1) return current;
      const merged = { ...current[index], ...patch };
      if (shallowEqualMeta(current[index], merged)) return current;
      const next = [...current];
      next[index] = merged;
      return next;
    });
  }, []);

  const forgetRead = useCallback((id: string) => {
    setHistory((current) => current.filter((h) => h.id !== id));
  }, []);

  // ---------------------------------------------------------------- searches

  const rememberSearch = useCallback((term: string) => {
    setRecentSearches((current) => {
      const next = mergeSearch(current, term);
      // Same contents in the same order: return the old array so nothing re-renders.
      if (next.length === current.length && next.every((t, i) => t === current[i])) {
        return current;
      }
      return next;
    });
  }, []);

  const forgetSearch = useCallback((term: string) => {
    setRecentSearches((current) =>
      current.filter((t) => t.toLowerCase() !== term.trim().toLowerCase()),
    );
  }, []);

  const clearSearches = useCallback(() => setRecentSearches([]), []);

  // ---------------------------------------------------------------- positions

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      void writeJson(POSITIONS_KEY, positions.current);
    }, 1200);
  }, []);

  const rememberPosition = useCallback(
    (id: string, spot: ReadingSpot) => {
      const fraction = Number.isFinite(spot.fraction)
        ? Math.min(Math.max(spot.fraction, 0), 1)
        : 0;
      positions.current[id] = { fraction, anchor: spot.anchor };
      trimRecord(positions.current, MAX_POSITIONS);
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

  useEffect(
    () => () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        void writeJson(POSITIONS_KEY, positions.current);
      }
    },
    [],
  );

  // ---------------------------------------------------------------- metadata cache

  const rememberPaper = useCallback((paper: PaperItem) => {
    if (!isUsefulMeta(paper)) return;
    const existing = known.current[paper.id];
    if (existing && existing.title === paper.title && existing.abstract === paper.abstract) {
      return;
    }
    known.current[paper.id] = paper;
    trimRecord(known.current, MAX_KNOWN);
    void writeJson(KNOWN_KEY, known.current);
  }, []);

  const paperMeta = useCallback((id: string) => known.current[id] ?? null, []);

  const value = useMemo<LibraryValue>(
    () => ({
      ready,
      favorites,
      isFavorite,
      toggleFavorite,
      updateFavorite,
      history,
      recordOpen,
      markFinished,
      updateHistory,
      forgetRead,
      recentSearches,
      rememberSearch,
      forgetSearch,
      clearSearches,
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
      history,
      recordOpen,
      markFinished,
      updateHistory,
      forgetRead,
      recentSearches,
      rememberSearch,
      forgetSearch,
      clearSearches,
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
  const value = useContext(LibraryContext);
  // A null default rather than a fabricated one: silently returning empty data would make a
  // misplaced provider look like "the user has saved nothing", which is a far worse bug to
  // track down than a crash at the call site.
  if (!value) throw new Error('useLibrary must be used inside a LibraryProvider');
  return value;
}

/** Compare the fields a repair can change, so an identical patch does not re-render. */
function shallowEqualMeta(a: MetaPatch, b: MetaPatch): boolean {
  return (
    a.title === b.title &&
    a.abstract === b.abstract &&
    a.category === b.category &&
    a.published === b.published &&
    a.authors.length === b.authors.length
  );
}
