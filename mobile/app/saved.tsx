/**
 * Saved screen.
 *
 * Reads entirely from local storage, so it works with no network. Saved papers keep their own
 * metadata (see src/library.tsx): a paper opened from arXiv search is not in the bundled list,
 * so storing only an id would leave this screen with nothing to show.
 *
 * Entries written before their metadata was known are repaired by `useRepairQueue`, which is
 * shared with History — the logic is subtle enough that having two copies of it was how it
 * stayed broken for two rounds of fixes.
 */

import { useMemo } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { PaperCard } from '../src/components/PaperCard';
import { useLibrary } from '../src/library';
import { useTheme, type Palette } from '../src/theme';
import type { PaperItem } from '../src/types';
import { useRepairQueue } from '../src/useRepair';

export default function SavedScreen() {
  const { palette } = useTheme();
  const { favorites, ready, updateFavorite, paperMeta } = useLibrary();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const repairing = useRepairQueue({
    entries: favorites,
    paperMeta,
    apply: updateFavorite,
  });

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
