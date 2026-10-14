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
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { fetchArxivById } from '../../src/arxiv';
import { PaperCard } from '../../src/components/PaperCard';
import { needsRepair, useLibrary } from '../../src/library';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

export default function FavoritesTab() {
  const { palette } = useTheme();
  const { favorites, ready, updateFavorite, paperMeta } = useLibrary();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  // Ids already attempted, so a failed lookup is not retried on every render.
  const attempted = useRef<Set<string>>(new Set());
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const pending = favorites.filter(
      (f) => needsRepair(f) && !attempted.current.has(f.id),
    );
    if (pending.length === 0) return;

    let alive = true;
    setRepairing(true);
    (async () => {
      for (const entry of pending) {
        attempted.current.add(entry.id);

        const cached = paperMeta(entry.id);
        if (cached) {
          updateFavorite(entry.id, {
            title: cached.title,
            abstract: cached.abstract,
            category: cached.category,
            authors: cached.authors,
            published: cached.published,
          });
          continue;
        }

        const remote = await fetchArxivById(entry.id);
        if (!alive) return;
        if (remote) {
          updateFavorite(entry.id, {
            title: remote.title,
            abstract: remote.abstract,
            category: remote.category,
            authors: remote.authors,
            published: remote.published ? remote.published.slice(0, 10) : null,
          });
        }
      }
      if (alive) setRepairing(false);
    })();

    return () => {
      alive = false;
    };
  }, [ready, favorites, updateFavorite, paperMeta]);

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
            {repairing && (
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
