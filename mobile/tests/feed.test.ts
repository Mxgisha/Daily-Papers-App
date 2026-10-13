/**
 * Cross-verification of the TypeScript port against the Python reference implementation.
 *
 * `recsys/feed.py` is the definition of correct. The fixtures in tests/fixtures/ are
 * generated from the *shipped bundle* by tests/make_fixtures.py, so these assertions check
 * the real artifacts rather than a synthetic stand-in: the vectors.bin reader, the
 * row-offset mapping, the int8 scoring, the candidate filter, and the MMR loop.
 *
 * Regenerate fixtures with:
 *   ../.venv/bin/python tests/make_fixtures.py --bundle ../dist --out tests/fixtures
 *
 * Run with:
 *   node --import tsx --test tests/feed.test.ts
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVectors, type VectorFile } from '../src/core/vectors';
import {
  Corpus,
  evaluateFeed,
  generateFeed,
  type FeedConfig,
  type Paper,
} from '../src/core/feed';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const BUNDLE = join(HERE, '..', '..', 'dist');

interface Expected {
  config: FeedConfig;
  nowMs: number;
  seedArxivIds: string[];
  seedIds: number[];
  stats: Record<string, unknown>;
  quality: Record<string, unknown>;
  feed: {
    rank: number;
    arxivId: string;
    score: number;
    components: Record<string, number>;
    stage: string;
  }[];
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

let vectors: VectorFile;
let corpus: Corpus;
let expected: Expected;

before(() => {
  if (!existsSync(join(FIXTURES, 'expected_feed.json'))) {
    throw new Error(
      `fixtures missing at ${FIXTURES}. Generate them first:\n` +
        `  ../.venv/bin/python tests/make_fixtures.py --bundle ../dist --out tests/fixtures`,
    );
  }
  vectors = parseVectors(toArrayBuffer(readFileSync(join(BUNDLE, 'vectors.bin'))));
  const papers = JSON.parse(
    readFileSync(join(FIXTURES, 'corpus.json'), 'utf-8'),
  ) as Paper[];
  corpus = new Corpus(papers, vectors);
  expected = JSON.parse(
    readFileSync(join(FIXTURES, 'expected_feed.json'), 'utf-8'),
  ) as Expected;
});

test('vectors.bin parses and matches the format contract', () => {
  assert.equal(vectors.encoding, 'int8');
  assert.equal(vectors.dim, 768);
  assert.ok(vectors.count > 1000, `expected a real corpus, got ${vectors.count}`);
  assert.equal(vectors.ids.length, vectors.count);
  assert.equal(vectors.scales.length, vectors.count);
  assert.equal(vectors.codes.length, vectors.count * vectors.dim);
  assert.equal(vectors.centroid.length, vectors.dim);

  // Centering is baked in at build time, so the centroid must be a real direction, not
  // an artefact. A near-zero norm would mean vectors shipped uncentered by accident.
  let norm = 0;
  for (const c of vectors.centroid) norm += c * c;
  norm = Math.sqrt(norm);
  assert.ok(norm > 0.5, `centroid norm ${norm.toFixed(3)} looks uncentered`);
});

test('paper ids are unique across the vector file', () => {
  const seen = new Set<number>();
  for (const id of vectors.ids) {
    const n = Number(id);
    assert.ok(!seen.has(n), `duplicate paper id ${n} in vectors.bin`);
    seen.add(n);
  }
  assert.equal(seen.size, vectors.count);
});

test('vec_index is a row offset whose id matches the paper (regression)', () => {
  // Guards the bug this port surfaced: vec_index was treated as a paper id and looked up
  // in the paper_id -> row map, returning a different paper's vector for almost every row.
  // It failed silently because recency and topic scores stayed correct.
  let checked = 0;
  for (const p of corpus.papers) {
    if (p.vecIndex === null) continue;
    assert.ok(
      p.vecIndex >= 0 && p.vecIndex < vectors.count,
      `paper ${p.id} has out-of-range vecIndex ${p.vecIndex}`,
    );
    assert.equal(
      Number(vectors.ids[p.vecIndex]),
      p.id,
      `row ${p.vecIndex} holds paper ${vectors.ids[p.vecIndex]}, expected ${p.id}`,
    );
    checked += 1;
  }
  assert.ok(checked > 1000, `only checked ${checked} mappings`);
});

test('seeds resolve to the same paper ids as Python', () => {
  const byArxiv = new Map(corpus.papers.map((p) => [p.arxivId, p.id]));
  const ids = expected.seedArxivIds.map((a) => byArxiv.get(a));
  assert.deepEqual(ids, expected.seedIds);
});

test('feed reproduces the Python ranking exactly', () => {
  const config: FeedConfig = { ...expected.config, explorationEpsilon: 0 };

  const { feed, stats } = generateFeed(corpus, expected.seedIds, config, {
    nowMs: expected.nowMs,
  });

  assert.equal(
    stats.candidates,
    expected.stats.candidates,
    'candidate count differs from Python',
  );
  assert.equal(stats.pool, expected.stats.pool, 'pool size differs from Python');
  assert.equal(feed.length, expected.feed.length, 'feed length differs');

  // Order is the assertion that matters: identical inputs must produce an identical feed.
  const gotOrder = feed.map((s) => s.paper.arxivId);
  const wantOrder = expected.feed.map((f) => f.arxivId);
  assert.deepEqual(gotOrder, wantOrder, 'feed ordering diverged from the Python reference');

  // Scores are compared with a tolerance: Python accumulates in float32 via numpy, this
  // port accumulates in float64. The ranking is what must match, not the last bit.
  for (let i = 0; i < feed.length; i++) {
    const got = feed[i];
    const want = expected.feed[i];
    assert.ok(
      Math.abs(got.score - want.score) < 1e-3,
      `rank ${i + 1} (${want.arxivId}) score ${got.score} != ${want.score}`,
    );
    for (const key of ['similarity', 'recency', 'topic_overlap', 'html'] as const) {
      assert.ok(
        Math.abs(got.components[key] - want.components[key]) < 1e-3,
        `rank ${i + 1} component ${key}: ${got.components[key]} != ${want.components[key]}`,
      );
    }
    assert.equal(got.stage, want.stage, `rank ${i + 1} stage differs`);
  }
});

test('feed quality metrics match the Python reference', () => {
  const config: FeedConfig = { ...expected.config, explorationEpsilon: 0 };
  const { feed } = generateFeed(corpus, expected.seedIds, config, {
    nowMs: expected.nowMs,
  });
  const quality = evaluateFeed(corpus, feed, expected.nowMs);
  if (!quality) throw new Error('evaluateFeed returned null for a non-empty feed');

  assert.equal(quality.distinctCategories, expected.quality.distinct_categories);
  assert.equal(quality.explorationItems, expected.quality.exploration_items);
  assert.equal(quality.size, expected.quality.size);
  assert.ok(
    Math.abs(quality.meanPairwiseSimilarity - (expected.quality.mean_pairwise_similarity as number)) < 1e-3,
    `pairwise similarity ${quality.meanPairwiseSimilarity} != ${expected.quality.mean_pairwise_similarity}`,
  );
  assert.ok(
    Math.abs(quality.topicEntropyNorm - (expected.quality.topic_entropy_norm as number)) < 2e-3,
    `entropy ${quality.topicEntropyNorm} != ${expected.quality.topic_entropy_norm}`,
  );
});

test('no already-seen paper appears in the feed', () => {
  const config: FeedConfig = { ...expected.config, explorationEpsilon: 0.15 };
  const exclude = new Set(expected.seedIds);
  const { feed } = generateFeed(corpus, expected.seedIds, config, {
    nowMs: expected.nowMs,
    exclude,
    rngSeed: 7,
  });

  for (const s of feed) {
    assert.ok(
      !exclude.has(s.paper.id),
      `excluded paper ${s.paper.arxivId} leaked into the feed`,
    );
  }

  // Every returned item must be unique, or the feed shows the same paper twice.
  const ids = feed.map((s) => s.paper.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate items in feed');
});

test('exploration respects the configured slot count', () => {
  const config: FeedConfig = { ...expected.config, explorationEpsilon: 0.15, feedSize: 20 };
  const { feed, stats } = generateFeed(corpus, expected.seedIds, config, {
    nowMs: expected.nowMs,
    rngSeed: 3,
  });
  assert.equal(stats.exploreSlots, 3);
  assert.equal(feed.filter((s) => s.stage === 'exploration').length, 3);
  assert.equal(feed.length, 20);
});
