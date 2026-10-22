/**
 * On-device feed generation.
 *
 * Port of `recsys/feed.py`. The Python implementation is the reference; `tests/feed.test.ts`
 * cross-checks this against it on the real bundle, so the two cannot drift silently.
 *
 * Pipeline: seeds -> user vector -> candidate pool -> score -> MMR diversify -> explore.
 *
 * Two details carried over deliberately:
 *
 *  - `papers.vec_index` *is* the row offset into vectors.bin. Python originally treated it
 *    as a paper id, which returned another paper's vector for almost every row. The lookup
 *    is written explicitly here to keep that from creeping back in.
 *  - `roundHalfEven` exists because Python's `round()` uses banker's rounding and
 *    `Math.round` does not; exploration slot counts would differ otherwise.
 */

import {
  decodeRow,
  normalizeInPlace,
  scoreAll,
  type VectorFile,
} from './vectors';

export interface Paper {
  id: number;
  arxivId: string;
  title: string;
  abstract: string;
  primaryCategory: string;
  categories: string[];
  topics: string[];
  /** epoch ms, or null */
  publishedAt: number | null;
  htmlAvailable: boolean;
  citationCount: number;
  /** row offset into vectors.bin, or null */
  vecIndex: number | null;
}

export interface FeedConfig {
  weights: { similarity: number; recency: number; topic_overlap: number };
  mmrLambda: number;
  explorationEpsilon: number;
  htmlBonus: number;
  recencyHalflifeDays: number;
  feedSize: number;
  candidatePool: number;
}

export const DEFAULT_CONFIG: FeedConfig = {
  weights: { similarity: 0.6, recency: 0.25, topic_overlap: 0.15 },
  mmrLambda: 0.7,
  explorationEpsilon: 0.15,
  htmlBonus: 0.05,
  recencyHalflifeDays: 14,
  feedSize: 20,
  candidatePool: 500,
};

/** Mirrors the ranking block written into manifest.json. */
export function configFromManifest(manifest: { ranking?: Record<string, unknown> }): FeedConfig {
  const r = (manifest.ranking ?? {}) as Partial<FeedConfig> & {
    weights?: Partial<FeedConfig['weights']>;
  };
  return {
    ...DEFAULT_CONFIG,
    ...r,
    weights: { ...DEFAULT_CONFIG.weights, ...(r.weights ?? {}) },
  };
}

export interface ScoreComponents {
  similarity: number;
  recency: number;
  topic_overlap: number;
  html: number;
}

export interface Scored {
  paper: Paper;
  score: number;
  components: ScoreComponents;
  stage: 'candidate' | 'ranked' | 'exploration';
}

export interface FeedStats {
  usedSeeds: number[];
  candidates: number;
  pool: number;
  rankedSlots: number;
  exploreSlots: number;
}

const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 400;

/** Python's `round()` rounds half to even; `Math.round` rounds half up. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export class Corpus {
  readonly papers: Paper[];
  readonly byId = new Map<number, Paper>();
  readonly vectors: VectorFile;
  /** row -> paper id */
  private readonly rowToId: number[];

  constructor(papers: Paper[], vectors: VectorFile) {
    this.papers = papers;
    this.vectors = vectors;
    for (const p of papers) this.byId.set(p.id, p);
    this.rowToId = Array.from(vectors.ids, (v) => Number(v));
  }

  get size(): number {
    return this.vectors.count;
  }

  /** Paper ids -> row offsets. vecIndex is already the row. */
  rowsFor(paperIds: number[]): { rows: number[]; keep: number[] } {
    const rows: number[] = [];
    const keep: number[] = [];
    for (const pid of paperIds) {
      const p = this.byId.get(pid);
      if (p && p.vecIndex !== null && p.vecIndex >= 0 && p.vecIndex < this.size) {
        rows.push(p.vecIndex);
        keep.push(pid);
      }
    }
    return { rows, keep };
  }

  /** Mean of the L2-normalized seed vectors, itself normalized. */
  userVector(seedIds: number[]): { vector: Float32Array | null; usedSeeds: number[] } {
    const { rows, keep } = this.rowsFor(seedIds);
    if (rows.length === 0) return { vector: null, usedSeeds: [] };

    const dim = this.vectors.dim;
    const mean = new Float64Array(dim);
    for (const row of rows) {
      const v = normalizeInPlace(decodeRow(this.vectors, row));
      for (let d = 0; d < dim; d++) mean[d] += v[d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      mean[d] /= rows.length;
      norm += mean[d] * mean[d];
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-9) return { vector: null, usedSeeds: keep };

    const out = new Float32Array(dim);
    for (let d = 0; d < dim; d++) out[d] = mean[d] / norm;
    return { vector: out, usedSeeds: keep };
  }

  /** Centered similarity for every paper, keyed by paper id. */
  scoreByPaper(query: Float32Array): Map<number, number> {
    const scores = scoreAll(this.vectors, query);
    const out = new Map<number, number>();
    for (let row = 0; row < this.vectors.count; row++) {
      out.set(this.rowToId[row], scores[row]);
    }
    return out;
  }

  /** Row vectors, decoded and normalized; used for MMR penalties. */
  decodedRows(rows: number[]): Float32Array[] {
    return rows.map((r) => normalizeInPlace(decodeRow(this.vectors, r)));
  }
}

export function recency(paper: Paper, nowMs: number, halflifeDays: number): number {
  if (paper.publishedAt === null) return 0;
  const ageDays = Math.max((nowMs - paper.publishedAt) / DAY_MS, 0);
  return Math.exp(-ageDays / Math.max(halflifeDays, 1e-6));
}

export function topicProfile(seeds: Paper[]): Map<string, number> {
  const profile = new Map<string, number>();
  for (const p of seeds) {
    for (const t of p.topics) profile.set(t, (profile.get(t) ?? 0) + 1);
  }
  let total = 0;
  for (const v of profile.values()) total += v;
  if (total > 0) for (const [k, v] of profile) profile.set(k, v / total);
  return profile;
}

export function topicOverlap(paper: Paper, profile: Map<string, number>): number {
  if (profile.size === 0 || paper.topics.length === 0) return 0;
  let sum = 0;
  for (const t of paper.topics) sum += profile.get(t) ?? 0;
  return sum;
}

/** Deterministic PRNG (mulberry32). NOT the same stream as Python's `random.sample`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenerateOptions {
  exclude?: Set<number>;
  nowMs?: number;
  rngSeed?: number;
}

export function generateFeed(
  corpus: Corpus,
  seedIds: number[],
  config: FeedConfig,
  options: GenerateOptions = {},
): { feed: Scored[]; stats: FeedStats } {
  const exclude = options.exclude ?? new Set<number>();
  const nowMs = options.nowMs ?? Date.now();
  const rand = mulberry32(options.rngSeed ?? 0);

  const { vector: userVec, usedSeeds } = corpus.userVector(seedIds);
  if (!userVec) {
    throw new Error('none of the seed papers have vectors in this corpus');
  }

  const seedPapers = usedSeeds
    .map((id) => corpus.byId.get(id))
    .filter((p): p is Paper => p !== undefined);
  const profile = topicProfile(seedPapers);
  const usedSeedSet = new Set(usedSeeds);

  // ---- Stage 1: candidate generation -----------------------------------
  const sims = corpus.scoreByPaper(userVec);
  const recentCutoffMs = nowMs - MAX_AGE_DAYS * DAY_MS;
  const w = config.weights;

  const candidates: Scored[] = [];
  for (const paper of corpus.papers) {
    if (exclude.has(paper.id) || usedSeedSet.has(paper.id)) continue;
    if (paper.vecIndex === null) continue;
    const sim = sims.get(paper.id);
    if (sim === undefined) continue;
    if (paper.publishedAt !== null && paper.publishedAt < recentCutoffMs) continue;

    const rec = recency(paper, nowMs, config.recencyHalflifeDays);
    const ov = Math.min(topicOverlap(paper, profile), 1.0);
    const html = paper.htmlAvailable ? 1 : 0;
    const score =
      w.similarity * sim + w.recency * rec + w.topic_overlap * ov + config.htmlBonus * html;

    candidates.push({
      paper,
      score,
      components: { similarity: sim, recency: rec, topic_overlap: ov, html },
      stage: 'candidate',
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const pool = candidates.slice(0, config.candidatePool);
  if (pool.length === 0) {
    return {
      feed: [],
      stats: { usedSeeds, candidates: 0, pool: 0, rankedSlots: 0, exploreSlots: 0 },
    };
  }

  // ---- Stage 2: MMR diversification ------------------------------------
  const { rows } = corpus.rowsFor(pool.map((s) => s.paper.id));
  const vecs = corpus.decodedRows(rows);
  const rowOf = new Map<number, number>();
  pool.forEach((s, i) => rowOf.set(s.paper.id, i));

  const raw = pool.map((s) => s.score);
  const lo = Math.min(...raw);
  const hi = Math.max(...raw);
  const norm = raw.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 1));

  const exploreSlots =
    config.explorationEpsilon > 0
      ? Math.max(1, roundHalfEven(config.explorationEpsilon * config.feedSize))
      : 0;
  const rankedSlots = Math.max(config.feedSize - exploreSlots, 0);

  // `vecs` is indexed by position within `rows`, which parallels `pool` only where a paper
  // had a vector. Map paper id -> index into vecs to keep the penalty lookup honest.
  const vecOf = new Map<number, number>();
  rows.forEach((_row, i) => {
    const paperId = pool[i]?.paper.id;
    if (paperId !== undefined) vecOf.set(paperId, i);
  });

  const selectedRows: number[] = [];
  const order: Scored[] = [];
  const remaining: number[] = pool.map((_, i) => i);

  while (remaining.length > 0 && order.length < rankedSlots) {
    let bestIdx: number | null = null;
    let bestVal = -Infinity;

    for (const i of remaining) {
      const pid = pool[i].paper.id;
      const vi = vecOf.get(pid);
      let penalty = 0;
      if (selectedRows.length > 0 && vi !== undefined) {
        let maxSim = -Infinity;
        for (const sr of selectedRows) {
          const v = vecs[sr];
          const u = vecs[vi];
          let dot = 0;
          for (let d = 0; d < v.length; d++) dot += v[d] * u[d];
          if (dot > maxSim) maxSim = dot;
        }
        penalty = maxSim === -Infinity ? 0 : maxSim;
      }
      const value = config.mmrLambda * norm[i] - (1 - config.mmrLambda) * penalty;
      if (value > bestVal) {
        bestVal = value;
        bestIdx = i;
      }
    }

    if (bestIdx === null) break;
    const pid = pool[bestIdx].paper.id;
    const vi = vecOf.get(pid);
    if (vi !== undefined) selectedRows.push(vi);
    const item = pool[bestIdx];
    item.stage = 'ranked';
    order.push(item);
    remaining.splice(remaining.indexOf(bestIdx), 1);
  }

  // ---- Stage 3: exploration --------------------------------------------
  // Sample from the tail, not the top: picking near-duplicates of what was already chosen
  // is not exploration, it is a worse version of stage 2.
  if (exploreSlots > 0 && remaining.length > 0) {
    const tail = remaining.slice(Math.floor(remaining.length / 2));
    const source = tail.length > 0 ? tail : remaining;
    const picks: number[] = [];
    const take = Math.min(exploreSlots, source.length);
    const poolCopy = [...source];
    for (let i = 0; i < take; i++) {
      const j = Math.floor(rand() * poolCopy.length);
      picks.push(poolCopy.splice(j, 1)[0]);
    }
    for (const idx of picks) {
      const item = pool[idx];
      item.stage = 'exploration';
      order.push(item);
    }
  }

  return {
    feed: order,
    stats: {
      usedSeeds,
      candidates: candidates.length,
      pool: pool.length,
      rankedSlots,
      exploreSlots,
    },
  };
}

// --------------------------------------------------------------------------
// Evaluation
// --------------------------------------------------------------------------

export interface FeedQuality {
  size: number;
  distinctCategories: number;
  categorySpread: Record<string, number>;
  topicEntropy: number;
  topicEntropyNorm: number;
  meanPairwiseSimilarity: number;
  meanAgeDays: number | null;
  pctHtml: number;
  explorationItems: number;
}

export function evaluateFeed(
  corpus: Corpus,
  feed: Scored[],
  nowMs: number = Date.now(),
): FeedQuality | null {
  if (feed.length === 0) return null;

  const cats: Record<string, number> = {};
  const topics = new Map<string, number>();
  const ages: number[] = [];
  let html = 0;

  for (const item of feed) {
    const p = item.paper;
    cats[p.primaryCategory] = (cats[p.primaryCategory] ?? 0) + 1;
    for (const t of p.topics) topics.set(t, (topics.get(t) ?? 0) + 1);
    if (p.publishedAt !== null) ages.push((nowMs - p.publishedAt) / DAY_MS);
    if (p.htmlAvailable) html += 1;
  }

  let totalTopics = 0;
  for (const n of topics.values()) totalTopics += n;
  let entropy = 0;
  for (const n of topics.values()) {
    const pr = n / totalTopics;
    entropy -= pr * Math.log(pr || 1e-12);
  }
  const maxEntropy = topics.size > 1 ? Math.log(topics.size) : 1;

  const { rows } = corpus.rowsFor(feed.map((s) => s.paper.id));
  const vecs = corpus.decodedRows(rows);
  let pairwise = 0;
  if (vecs.length > 1) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        let dot = 0;
        for (let d = 0; d < vecs[i].length; d++) dot += vecs[i][d] * vecs[j][d];
        sum += dot;
        pairs += 1;
      }
    }
    pairwise = pairs > 0 ? sum / pairs : 0;
  }

  const sortedCats = Object.fromEntries(
    Object.entries(cats).sort((a, b) => b[1] - a[1]),
  );

  return {
    size: feed.length,
    distinctCategories: Object.keys(cats).length,
    categorySpread: sortedCats,
    topicEntropy: Math.round(entropy * 1000) / 1000,
    topicEntropyNorm: maxEntropy ? Math.round((entropy / maxEntropy) * 1000) / 1000 : 0,
    meanPairwiseSimilarity: Math.round(pairwise * 1000) / 1000,
    meanAgeDays:
      ages.length > 0
        ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10
        : null,
    pctHtml: Math.round((1000 * html) / feed.length) / 10,
    explorationItems: feed.filter((s) => s.stage === 'exploration').length,
  };
}
