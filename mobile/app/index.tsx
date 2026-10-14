/**
 * Paper list — the reader MVP's entry point.
 *
 * Deliberately simple: a bundled list of papers plus a single input that either filters the
 * list or opens an arbitrary arXiv ID. No bundle download, no vectors, no SQLite, no
 * recommendations. The point of this screen is to get to the reader in one tap.
 */

import { useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import papersJson from '../assets/papers.json';

interface Paper {
  id: string;
  title: string;
  abstract: string;
  category: string;
  published: string | null;
  html: boolean;
  pdf: string | null;
  citations: number;
  authors: string[];
}

const DATA = papersJson as { papers: Paper[]; generated: string };
const PAPERS = DATA.papers;
const GENERATED = DATA.generated.slice(0, 10);

/** New-style (2610.13935) or old-style (math.GT/0309136), with an optional version. */
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(v\d+)?$/;

export default function PaperList() {
  const router = useRouter();
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const typedId = ARXIV_ID.test(trimmed) ? trimmed : null;

  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (!q) return PAPERS;
    return PAPERS.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.abstract.toLowerCase().includes(q),
    );
  }, [trimmed]);

  const open = (id: string) => {
    Keyboard.dismiss();
    router.push(`/read/${id}`);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => typedId && open(typedId)}
          placeholder="Filter papers, or paste an arXiv ID"
          placeholderTextColor="#6f757d"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          style={styles.input}
        />
        <Text style={styles.meta}>
          {trimmed && !typedId
            ? `${filtered.length} of ${PAPERS.length} papers`
            : `${PAPERS.length} papers · list built ${GENERATED}`}
        </Text>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        // The "open this ID" affordance sits at the top of the list rather than behind a
        // separate button, so one input serves both intents.
        ListHeaderComponent={
          typedId ? (
            <Pressable style={styles.openRow} onPress={() => open(typedId)}>
              <Text style={styles.openTitle}>Open {typedId}</Text>
              <Text style={styles.openHint}>fetch this paper from arXiv</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            No paper matches “{trimmed}”. Paste an arXiv ID to open it directly.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => open(item.id)}>
            <Text style={styles.cardMeta}>
              {item.id} · {item.category}
              {item.published ? ` · ${item.published}` : ''}
              {item.html ? '' : ' · PDF only'}
            </Text>
            <Text style={styles.cardTitle}>{item.title}</Text>
            {item.authors.length > 0 && (
              <Text style={styles.cardAuthors} numberOfLines={1}>
                {item.authors.join(', ')}
              </Text>
            )}
            <Text style={styles.cardAbstract} numberOfLines={2}>
              {item.abstract}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#16181c' },
  header: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 6 },
  input: {
    backgroundColor: '#1e2126',
    borderWidth: 1,
    borderColor: '#2b2f36',
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e6e6e6',
    fontSize: 15,
  },
  meta: { color: '#8b9199', fontSize: 11, paddingHorizontal: 2 },
  openRow: {
    margin: 14,
    marginTop: 6,
    padding: 14,
    borderRadius: 9,
    backgroundColor: '#1b2a3a',
    borderWidth: 1,
    borderColor: '#2f4a66',
    gap: 2,
  },
  openTitle: { color: '#8ab4f8', fontSize: 15, fontWeight: '600' },
  openHint: { color: '#7a97b5', fontSize: 12 },
  empty: { color: '#8b9199', fontSize: 13, padding: 20, textAlign: 'center' },
  card: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2b2f36',
    gap: 4,
  },
  cardMeta: {
    color: '#8ab4f8',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardTitle: { color: '#f0f0f0', fontSize: 15.5, fontWeight: '600', lineHeight: 21 },
  cardAuthors: { color: '#9aa0a8', fontSize: 12 },
  cardAbstract: { color: '#a8adb5', fontSize: 12.5, lineHeight: 18 },
});
