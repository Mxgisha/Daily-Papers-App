/**
 * Reading history, with finished reads as a filter rather than a separate screen.
 *
 * Finished is a property of a paper you have read, not a different kind of paper, so it is a
 * filter over one list — a second screen would have been the same code with a different
 * `where` clause, and two places for the repair path to drift.
 *
 * Entries are recorded by the reader on open. Anything stored before its metadata was known
 * is repaired by the same shared queue the Saved screen uses.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { PaperCard } from '../src/components/PaperCard';
import { useLibrary } from '../src/library';
import { useTheme, type Palette } from '../src/theme';
import type { PaperItem } from '../src/types';
import { useRepairQueue } from '../src/useRepair';

type Filter = 'all' | 'reading' | 'finished';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'reading', label: 'Reading' },
  { key: 'finished', label: 'Finished' },
];

export default function HistoryScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { history, ready, updateHistory, paperMeta, markFinished, forgetRead } = useLibrary();
  const [filter, setFilter] = useState<Filter>('all');
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const repairing = useRepairQueue({
    entries: history,
    paperMeta,
    apply: updateHistory,
  });

  const counts = useMemo(
    () => ({
      all: history.length,
      reading: history.filter((h) => !h.finishedAt).length,
      finished: history.filter((h) => h.finishedAt).length,
    }),
    [history],
  );

  const visible = useMemo(() => {
    if (filter === 'finished') return history.filter((h) => h.finishedAt);
    if (filter === 'reading') return history.filter((h) => !h.finishedAt);
    return history;
  }, [history, filter]);

  /**
   * The rendered rows, carrying their own history record.
   *
   * Built once as a pair rather than looked up by id inside the row, which would have made
   * rendering the list quadratic in the size of the history.
   */
  const rows = useMemo(
    () =>
      visible.map((h) => ({
        entry: h,
        item: {
          id: h.id,
          title: h.title,
          abstract: h.abstract,
          category: h.category,
          published: h.published,
          authors: h.authors,
        } satisfies PaperItem,
      })),
    [visible],
  );

  const renderItem = useCallback(
    ({ item }: { item: (typeof rows)[number] }) => (
      <View>
        <PaperCard item={item.item} />
        <View style={styles.actions}>
          <Pressable
            onPress={() => markFinished(item.entry.id, !item.entry.finishedAt)}
            testID={`finished-${item.entry.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: !!item.entry.finishedAt }}
            accessibilityLabel={
              item.entry.finishedAt
                ? `Mark ${item.item.title} as unfinished`
                : `Mark ${item.item.title} as finished`
            }
            hitSlop={8}
            style={styles.action}
          >
            <Text
              style={[styles.actionText, item.entry.finishedAt ? styles.actionOn : null]}
            >
              {item.entry.finishedAt ? '✓ Finished' : 'Mark finished'}
            </Text>
          </Pressable>
          <Text style={styles.opened}>{relativeTime(item.entry.lastOpenedAt)}</Text>
          <Pressable
            onPress={() => forgetRead(item.entry.id)}
            testID={`forget-${item.entry.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.item.title} from history`}
            hitSlop={8}
            style={styles.action}
          >
            <Text style={styles.actionText}>Remove</Text>
          </Pressable>
        </View>
      </View>
    ),
    [markFinished, forgetRead, styles],
  );

  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.entry.id}
        ListHeaderComponent={
          <View style={styles.head}>
            <Text style={styles.meta}>
              {ready
                ? rows.length === 0
                  ? filter === 'finished'
                    ? 'Nothing finished yet. Open a paper and mark it when you are done.'
                    : 'Nothing read yet. Papers you open show up here.'
                  : `${rows.length} paper${rows.length === 1 ? '' : 's'}`
                : 'Loading…'}
            </Text>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              {FILTERS.map((f) => {
                const active = f.key === filter;
                return (
                  <Pressable
                    key={f.key}
                    testID={`history-filter-${f.key}`}
                    onPress={() => setFilter(f.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {f.label} {counts[f.key]}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {repairing > 0 && (
              <View style={styles.repairRow}>
                <ActivityIndicator size="small" color={palette.accent} />
                <Text style={styles.repairText}>Fetching details…</Text>
              </View>
            )}
          </View>
        }
        renderItem={renderItem}
        ListFooterComponent={
          rows.length > 0 ? (
            <Pressable
              onPress={() => router.navigate('/')}
              style={styles.footerLink}
              accessibilityRole="button"
            >
              <Text style={styles.footerText}>Find something else to read →</Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

/**
 * Coarse relative time. Deliberately not "3 minutes ago": at this granularity the exact
 * interval is noise, and a coarse label does not need to re-render as time passes.
 */
function relativeTime(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 3600) return 'just now';
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

const makeStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    head: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, gap: 8 },
    meta: { color: p.dim, fontSize: 12 },
    chips: { gap: 7, flexDirection: 'row' },
    chip: {
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: p.chipBg,
      borderWidth: 1,
      borderColor: p.border,
    },
    chipActive: { backgroundColor: p.chipActiveBg, borderColor: p.chipActiveBg },
    chipText: { color: p.dim, fontSize: 12.5 },
    chipTextActive: { color: p.chipActiveText, fontWeight: '600' },
    repairRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    repairText: { color: p.dim, fontSize: 11.5 },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    action: { paddingVertical: 2 },
    actionText: { color: p.dim, fontSize: 12.5 },
    actionOn: { color: p.accent, fontWeight: '600' },
    opened: { color: p.dim, fontSize: 11.5, flex: 1 },
    footerLink: { padding: 22, alignItems: 'center' },
    footerText: { color: p.accent, fontSize: 13 },
  });
