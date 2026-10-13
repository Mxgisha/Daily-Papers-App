/**
 * The daily feed.
 *
 * Runs the whole on-device pipeline: install/load the bundle, pick onboarding seeds, generate
 * a ranked feed, and render it. There is no server call anywhere in this path.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { generateFeed, configFromManifest, type Corpus, type Scored } from '../src/core/feed';
import { pickSeeds } from '../src/core/seeds';
import { installBundle, isInstalled, loadBundle, type Manifest } from '../src/platform/bundle';

/**
 * Where the static bundle is served from during development.
 *
 * 10.0.2.2 reaches the host machine from an Android emulator. For a physical device use
 * the host's LAN IP, e.g. EXPO_PUBLIC_BUNDLE_URL=http://192.168.1.20:8000
 *
 * Serve the artifacts with:
 *   cd dist && python3 -m http.server 8000
 */
const BUNDLE_BASE_URL = process.env.EXPO_PUBLIC_BUNDLE_URL ?? 'http://10.0.2.2:8000';

const SEED_COUNT = 5;

export default function FeedScreen() {
  const router = useRouter();
  const [feed, setFeed] = useState<Scored[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [status, setStatus] = useState('starting');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let active: Manifest | null = null;
      if (force || !isInstalled()) {
        setStatus('fetching bundle');
        active = await installBundle(BUNDLE_BASE_URL, (stage) => setStatus(stage));
      }

      setStatus('opening bundle');
      const { corpus, manifest: m } = await loadBundle();
      active = m;
      setManifest(m);

      setStatus('building feed');
      const seeds = pickSeeds(corpus, SEED_COUNT);
      if (seeds.length === 0) throw new Error('bundle contains no renderable papers');

      const config = configFromManifest(m);
      const { feed: items, stats } = generateFeed(
        corpus,
        seeds.map((p) => p.id),
        config,
        { rngSeed: Date.now() % 100000 },
      );

      setFeed(items);
      setStatus(
        `${items.length} papers · ${stats.candidates} candidates · ${corpus.size} in corpus`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <View style={styles.screen}>
      <FlatList
        data={feed}
        keyExtractor={(item) => String(item.paper.id)}
        refreshControl={
          <RefreshControl refreshing={busy} onRefresh={() => load(false)} tintColor="#8ab4f8" />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            {busy && <ActivityIndicator color="#8ab4f8" />}
            <Text style={styles.status}>{error ? `error: ${error}` : status}</Text>
            {manifest && (
              <Text style={styles.substatus}>
                bundle {manifest.generated_at.slice(0, 10)} ·{' '}
                {manifest.corpus.papers.toLocaleString()} papers ·{' '}
                {(100 * manifest.corpus.html_coverage).toFixed(0)}% HTML ·{' '}
                {manifest.encoding.encoding}
              </Text>
            )}
          </View>
        }
        renderItem={({ item, index }) => (
          <Pressable
            style={styles.card}
            onPress={() => router.push(`/read/${item.paper.arxivId}`)}
          >
            <Text style={styles.rank}>
              {index + 1} · {item.paper.primaryCategory}
              {item.stage === 'exploration' ? ' · exploring' : ''}
            </Text>
            <Text style={styles.title}>{item.paper.title}</Text>
            <Text style={styles.abstract} numberOfLines={3}>
              {item.paper.abstract}
            </Text>
            <Text style={styles.components}>
              score {item.score.toFixed(3)} · sim {item.components.similarity.toFixed(3)} · rec{' '}
              {item.components.recency.toFixed(2)} · topic{' '}
              {item.components.topic_overlap.toFixed(2)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#16181c' },
  header: { padding: 16, gap: 6 },
  status: { color: '#e6e6e6', fontSize: 13 },
  substatus: { color: '#9aa0a8', fontSize: 11 },
  card: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2b2f36',
    gap: 5,
  },
  rank: { color: '#8ab4f8', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { color: '#f0f0f0', fontSize: 16, fontWeight: '600', lineHeight: 22 },
  abstract: { color: '#a8adb5', fontSize: 13, lineHeight: 19 },
  components: { color: '#6f757d', fontSize: 10 },
});
