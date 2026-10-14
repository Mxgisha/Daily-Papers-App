/**
 * Saved tab.
 *
 * Reads entirely from local storage, so it works with no network. Saved papers keep their
 * own metadata (see src/library.tsx): a paper opened from arXiv search is not in the bundled
 * list, so storing only an id would leave this tab with nothing to show.
 */

import { useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { PaperCard } from '../../src/components/PaperCard';
import { useLibrary } from '../../src/library';
import { useTheme, type Palette } from '../../src/theme';
import type { PaperItem } from '../../src/types';

export default function FavoritesTab() {
  const { palette } = useTheme();
  const { favorites, ready } = useLibrary();
  const styles = useMemo(() => makeStyles(palette), [palette]);

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
          <Text style={styles.meta}>
            {ready
              ? items.length === 0
                ? 'Nothing saved yet. Tap ☆ on any paper to keep it here.'
                : `${items.length} saved paper${items.length === 1 ? '' : 's'}`
              : 'Loading…'}
          </Text>
        }
        renderItem={({ item }) => <PaperCard item={item} />}
      />
    </View>
  );
}

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    meta: { color: p.dim, fontSize: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  });
