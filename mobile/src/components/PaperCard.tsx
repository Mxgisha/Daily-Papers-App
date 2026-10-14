import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useLibrary } from '../library';
import { useTheme, type Palette } from '../theme';
import type { PaperItem } from '../types';

/**
 * One paper row, shared by the Papers and Favorites tabs.
 *
 * The save control is a separate Pressable from the card, so tapping the star saves and
 * tapping anywhere else opens — rather than the star being swallowed by the row's own press
 * handler.
 */
function PaperCardBase({ item }: { item: PaperItem }) {
  const router = useRouter();
  const { palette } = useTheme();
  const { isFavorite, toggleFavorite } = useLibrary();
  const saved = isFavorite(item.id);
  const styles = makeStyles(palette);

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.main}
        onPress={() => router.push(`/read/${encodeURIComponent(item.id)}`)}
      >
        <Text style={styles.meta}>
          {item.id} · {item.category}
          {item.published ? ` · ${item.published}` : ''}
        </Text>
        <Text style={styles.title}>{item.title}</Text>
        {item.authors.length > 0 && (
          <Text style={styles.authors} numberOfLines={1}>
            {item.authors.join(', ')}
          </Text>
        )}
        <Text style={styles.abstract} numberOfLines={2}>
          {item.abstract}
        </Text>
      </Pressable>

      <Pressable
        onPress={() =>
          toggleFavorite({
            id: item.id,
            title: item.title,
            category: item.category,
            published: item.published,
            authors: item.authors,
            abstract: item.abstract,
          })
        }
        testID={`save-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={saved ? `Remove ${item.title} from favorites` : `Save ${item.title}`}
        hitSlop={12}
        style={styles.star}
      >
        <Text style={[styles.starText, saved && styles.starTextOn]}>{saved ? '★' : '☆'}</Text>
      </Pressable>
    </View>
  );
}

export const PaperCard = memo(PaperCardBase);

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
    },
    main: { flex: 1, paddingHorizontal: 14, paddingVertical: 13, gap: 4 },
    star: { paddingHorizontal: 12, paddingTop: 12 },
    starText: { fontSize: 20, color: p.dim },
    starTextOn: { color: p.accent },
    meta: { color: p.accent, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
    title: { color: p.text, fontSize: 15.5, fontWeight: '600', lineHeight: 21 },
    authors: { color: p.dim, fontSize: 12 },
    abstract: { color: p.dim, fontSize: 12.5, lineHeight: 18 },
  });
