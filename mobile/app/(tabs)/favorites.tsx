/**
 * Saved tab.
 *
 * Reads entirely from local storage, so it works with no network. Saved papers keep their
 * own metadata (see src/library.tsx): a paper opened from arXiv search is not in the bundled
 * list, so storing only an id would leave this tab with nothing to show.
 *
 * It also repairs. An entry can be saved before its metadata is known — a cold open, or a tap
 * on the star before the arXiv lookup returned — and is then stored with the id as its title
 * and no abstract. Toggling such an entry would just delete it, so this fills the gaps in
 * place: from the local metadata cache first, which is free, and from arXiv only if that
 * misses.
 *
 * The cache read is guarded by `isUsefulMeta`, and that guard is the whole reason this works.
 * This tab renders the same PaperCard as everywhere else, and PaperCard registers whatever it
 * renders — so a broken entry used to register itself into the metadata cache, and the repair
 * would then read back the broken values, find them identical, and conclude there was nothing
 * to do. `rememberPaper` now refuses to cache placeholders, and this checks anyway, because a
 * poisoned cache may already have been persisted on a device.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { fetchArxivById } from '../../src/arxiv';
import { PaperCard } from '../../src/components/PaperCard';
import {
  isUsefulMeta,
  needsRepair,
  useLibrary,
  type SavedPaper,
} from '../../src/library';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

type Patch = Partial<Omit<SavedPaper, 'id' | 'savedAt'>>;

export default function FavoritesTab() {
  const { palette } = useTheme();
  const { favorites, ready, updateFavorite, paperMeta } = useLibrary();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  /** Ids with a lookup in flight, so a re-render does not start a second one. */
  const inFlight = useRef<Set<string>>(new Set());
  const [repairing, setRepairing] = useState(0);

  const patchFrom = useCallback(
    (id: string): Patch | null => {
      const cached = paperMeta(id);
      // A cache hit is only useful if it is actually better than what we have.
      if (!cached || !isUsefulMeta(cached)) return null;
      return {
        title: cached.title,
        abstract: cached.abstract,
        category: cached.category,
        authors: cached.authors,
        published: cached.published,
      };
    },
    [paperMeta],
  );

  /**
   * Repair entries whose metadata was never known.
   *
   * Note what this does NOT do: it is not guarded by an `alive` flag cleared in a cleanup.
   * The first version was, and React runs effects twice in development (Expo Go is a
   * development build), so the first pass added the id to its `attempted` set and started the
   * lookup, the cleanup cancelled it, and the second pass found the id already attempted and
   * returned. Work that has to finish must not be tied to an effect that may be torn down.
   */
  useEffect(() => {
    if (!ready) return;
    const pending = favorites.filter(
      (f) => needsRepair(f) && !inFlight.current.has(f.id),
    );
    if (pending.length === 0) return;

    for (const entry of pending) {
      inFlight.current.add(entry.id);
      setRepairing((n) => n + 1);

      void (async () => {
        try {
          let patch = patchFrom(entry.id);
          if (!patch) {
            const remote = await fetchArxivById(entry.id);
            if (remote) {
              patch = {
                title: remote.title,
                abstract: remote.abstract,
                category: remote.category,
                authors: remote.authors,
                published: remote.published ? remote.published.slice(0, 10) : null,
              };
            }
          }
          if (patch) updateFavorite(entry.id, patch);
        } catch {
          // Leave the entry as it is; a later render tries again.
        } finally {
          // Cleared either way. On success `needsRepair` is false so it will not be picked up
          // again; on failure a later render gets another chance rather than the entry being
          // written off for the session.
          inFlight.current.delete(entry.id);
          setRepairing((n) => Math.max(0, n - 1));
        }
      })();
    }
  }, [ready, favorites, updateFavorite, patchFrom]);

  const items: PaperItem[] = favorites.map((f) => ({
    id: f.id,
    title: f.title,
    abstract: f.abstract,
    category: f.category,
    published: f.published,
    authors: f.authors,
  }));

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <View style={styles.head}>
            <Text style={styles.meta}>
              {ready
                ? items.length === 0
                  ? 'Nothing saved yet. Tap ☆ on any paper to keep it here.'
                  : `${items.length} saved paper${items.length === 1 ? '' : 's'}`
                : 'Loading…'}
            </Text>
            {repairing > 0 && (
              <View style={styles.repairRow}>
                <ActivityIndicator size="small" color={palette.accent} />
                <Text style={styles.repairText}>Fetching saved details…</Text>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => <PaperCard item={item} />}
      />
    </View>
  );
}

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    head: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, gap: 6 },
    meta: { color: p.dim, fontSize: 12 },
    repairRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    repairText: { color: p.dim, fontSize: 11.5 },
  });
