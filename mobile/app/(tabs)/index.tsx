/**
 * Papers tab.
 *
 * Three ways in, in order of how much they cost:
 *   - filter the bundled list (instant, offline)
 *   - pick a topic (instant, offline)
 *   - search all of arXiv (network, on submit only)
 *
 * Plus a paper of the day. See src/hot.ts for why that uses Hugging Face upvotes rather than
 * citations, and what it does when the network is unavailable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import papersJson from '../../assets/papers.json';
import { searchArxiv } from '../../src/arxiv';
import { PaperCard } from '../../src/components/PaperCard';
import { fetchPaperOfTheDay, type HotPaper } from '../../src/hot';
import { useTheme, type Palette } from '../../src/theme';
import { TOPIC_GROUPS, matchesTopic, topicCounts } from '../../src/topics';
import type { PaperItem } from '../../src/types';

const DATA = papersJson as { papers: PaperItem[]; generated: string };
const PAPERS: PaperItem[] = DATA.papers;
const GENERATED = DATA.generated.slice(0, 10);

/** New-style (2610.13935) or old-style (math.GT/0309136), with an optional version. */
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(v\d+)?$/;

export default function PapersTab() {
  const router = useRouter();
  const { palette } = useTheme();

  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('all');
  const [remote, setRemote] = useState<PaperItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hot, setHot] = useState<HotPaper | null>(null);

  const trimmed = query.trim();
  const typedId = ARXIV_ID.test(trimmed) ? trimmed : null;

  const counts = useMemo(() => topicCounts(PAPERS.map((p) => p.category)), []);

  useEffect(() => {
    let alive = true;
    fetchPaperOfTheDay(PAPERS).then((p) => {
      if (alive) setHot(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const runRemoteSearch = useCallback(async () => {
    const q = trimmed;
    if (!q || ARXIV_ID.test(q)) return;
    Keyboard.dismiss();
    setSearching(true);
    setSearchError(null);
    try {
      const results = await searchArxiv(q, 30);
      setRemote(
        results.map((r) => ({
          id: r.id,
          title: r.title,
          abstract: r.abstract,
          category: r.category,
          published: r.published ? r.published.slice(0, 10) : null,
          authors: r.authors,
        })),
      );
      if (results.length === 0) setSearchError(`arXiv returned nothing for “${q}”`);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setRemote(null);
    } finally {
      setSearching(false);
    }
  }, [trimmed]);

  const source = remote ?? PAPERS;

  const items = useMemo(() => {
    const q = trimmed.toLowerCase();
    return source.filter((p) => {
      if (!matchesTopic(p.category, topic)) return false;
      // Remote results are already matched by arXiv; only re-filter locally.
      if (!q || remote) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.abstract.toLowerCase().includes(q)
      );
    });
  }, [source, trimmed, topic, remote]);

  const styles = useMemo(() => makeStyles(palette), [palette]);

  const header = (
    <View>
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            if (remote) setRemote(null);
          }}
          onSubmitEditing={runRemoteSearch}
          placeholder="Filter, or search all of arXiv"
          placeholderTextColor={palette.dim}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
        />

        {typedId ? (
          <Pressable
            style={styles.openRow}
            onPress={() => router.push(`/read/${encodeURIComponent(typedId)}`)}
          >
            <Text style={styles.openTitle}>Open {typedId}</Text>
            <Text style={styles.openHint}>fetch this paper from arXiv</Text>
          </Pressable>
        ) : (
          <View style={styles.row}>
            <Text style={styles.meta}>
              {remote
                ? `${items.length} arXiv results`
                : trimmed
                  ? `${items.length} of ${PAPERS.length} bundled`
                  : `${PAPERS.length} papers · built ${GENERATED}`}
            </Text>
            {trimmed.length > 1 && (
              <Pressable onPress={runRemoteSearch} hitSlop={8}>
                <Text style={styles.link}>
                  {searching ? 'searching…' : 'Search all of arXiv'}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {TOPIC_GROUPS.filter((g) => g.key === 'all' || counts[g.key] > 0).map((g) => {
          const active = g.key === topic;
          return (
            <Pressable
              key={g.key}
              onPress={() => setTopic(g.key)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {g.label}
                {g.key !== 'all' ? ` ${counts[g.key]}` : ''}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {hot && (
        <Pressable
          style={styles.hot}
          onPress={() => router.push(`/read/${encodeURIComponent(hot.id)}`)}
        >
          <Text style={styles.hotLabel}>
            {hot.source === 'huggingface'
              ? `PAPER OF THE DAY · ${hot.upvotes} UPVOTES ON HF`
              : 'PAPER OF THE DAY'}
          </Text>
          <Text style={styles.hotTitle}>{hot.title}</Text>
          <Text style={styles.hotSummary} numberOfLines={2}>
            {hot.summary}
          </Text>
        </Pressable>
      )}

      {searching && <ActivityIndicator style={{ marginTop: 12 }} color={palette.accent} />}
      {searchError && <Text style={styles.error}>{searchError}</Text>}
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {searching
              ? 'Searching arXiv…'
              : `Nothing matches.${trimmed ? ' Try “Search all of arXiv”.' : ''}`}
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
    header: { paddingHorizontal: 14, paddingTop: 12, gap: 6 },
    input: {
      backgroundColor: p.inputBg,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: p.text,
      fontSize: 15,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    meta: { color: p.dim, fontSize: 11, paddingHorizontal: 2 },
    link: { color: p.accent, fontSize: 12, fontWeight: '600' },
    error: { color: '#e5534b', fontSize: 12, paddingHorizontal: 16, paddingTop: 8 },
    chips: { paddingHorizontal: 12, paddingVertical: 10, gap: 7, flexDirection: 'row' },
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
    hot: {
      marginHorizontal: 14,
      marginBottom: 4,
      padding: 14,
      borderRadius: 10,
      backgroundColor: p.inputBg,
      borderWidth: 1,
      borderColor: p.border,
      gap: 5,
    },
    hotLabel: { color: p.accent, fontSize: 10, fontWeight: '700', letterSpacing: 0.7 },
    hotTitle: { color: p.text, fontSize: 16, fontWeight: '700', lineHeight: 22 },
    hotSummary: { color: p.dim, fontSize: 12.5, lineHeight: 18 },
    openRow: {
      marginTop: 6,
      padding: 14,
      borderRadius: 9,
      backgroundColor: p.chipActiveBg,
      gap: 2,
    },
    openTitle: { color: p.chipActiveText, fontSize: 15, fontWeight: '600' },
    openHint: { color: p.dim, fontSize: 12 },
    empty: { color: p.dim, fontSize: 13, padding: 24, textAlign: 'center' },
  });
