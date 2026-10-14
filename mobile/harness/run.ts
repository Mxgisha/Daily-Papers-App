/**
 * Browser harness: executes the real client core against the real bundle.
 *
 * This exists because Phase 1 shipped a client that *compiled* but had never run. `expo
 * export` proves Metro resolves imports; it proves nothing about whether the bundle can be
 * downloaded, decompressed, parsed and turned into a feed.
 *
 * It runs the actual `src/core/` modules -- the same files the app imports -- in a real
 * browser engine, over real HTTP, against real artifacts. Deliberately not a mock:
 *
 *   fetch manifest  ->  fetch vectors.bin  ->  SHA-256 verify  ->  parse
 *   fetch delta     ->  fzstd decompress   ->  build corpus
 *   pick seeds      ->  generate feed      ->  evaluate
 *
 * What it does NOT cover, and cannot: `expo-file-system`, `expo-sqlite`, and the WebView
 * reader, all of which need a device. Hermes is also not exercised (this is V8). Those
 * remain unverified and are listed as such.
 */

import { decompress } from 'fzstd';
import { sha256 } from 'js-sha256';

import {
  Corpus,
  configFromManifest,
  evaluateFeed,
  generateFeed,
  type FeedConfig,
  type Paper,
  type Scored,
} from '../src/core/feed';
import { findExpectation, verifyFile, type Digest } from '../src/core/integrity';
import { pickSeeds } from '../src/core/seeds';
import { parseVectors } from '../src/core/vectors';

const digest: Digest = async (data) => sha256(new Uint8Array(data));

interface Manifest {
  generated_at: string;
  corpus: { papers: number; html_coverage: number };
  encoding: { encoding: string; count: number; dim: number };
  files: { name: string; bytes: number; sha256: string }[];
  ranking: Record<string, unknown>;
}

interface DeltaRecord {
  id: number;
  vec_index: number;
  scale: number;
  vec: string; // base64 int8
  arxiv_id: string;
  title: string;
  abstract: string;
  primary_category: string;
  categories: string[];
  published_at: string | null;
  html_available: boolean;
  citation_count: number;
  /** [[topic_name, score], ...] -- omitted entirely until this phase, which silently
   *  disabled the topic_overlap ranking component for every delta-sourced paper. */
  topics: [string, number][] | null;
}

function base64ToInt8(b64: string): Int8Array {
  const binary = atob(b64);
  const out = new Int8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) << 24 >> 24;
  return out;
}

function toPaper(r: DeltaRecord): Paper {
  return {
    id: r.id,
    arxivId: r.arxiv_id,
    title: r.title,
    abstract: r.abstract ?? '',
    primaryCategory: r.primary_category ?? '',
    categories: r.categories ?? [],
    topics: (r.topics ?? []).map(([name]) => name),
    publishedAt: r.published_at ? Date.parse(r.published_at) : null,
    htmlAvailable: !!r.html_available,
    citationCount: r.citation_count ?? 0,
    vecIndex: r.vec_index,
  };
}

interface HarnessResult {
  ok: boolean;
  error?: string;
  stages: { name: string; ms: number; detail: string }[];
  manifest?: Partial<Manifest>;
  feed?: {
    rank: number;
    arxivId: string;
    title: string;
    category: string;
    score: number;
    similarity: number;
    stage: string;
  }[];
  quality?: Record<string, unknown>;
  checks: { name: string; pass: boolean; detail: string }[];
}

async function run(): Promise<HarnessResult> {
  const stages: HarnessResult['stages'] = [];
  const checks: HarnessResult['checks'] = [];
  const mark = async <T>(name: string, fn: () => Promise<T>, detail: (v: T) => string): Promise<T> => {
    const t0 = performance.now();
    const value = await fn();
    stages.push({ name, ms: Math.round(performance.now() - t0), detail: detail(value) });
    return value;
  };

  // ---- 1. manifest -----------------------------------------------------
  const manifest = await mark(
    'fetch manifest',
    async () => (await (await fetch('/manifest.json')).json()) as Manifest,
    (m) => `${m.corpus.papers} papers, built ${m.generated_at}`,
  );

  // ---- 2. vectors, with the real integrity path ------------------------
  const vectors = await mark(
    'download + verify + parse vectors.bin',
    async () => {
      const buf = await (await fetch('/vectors.bin')).arrayBuffer();
      const expected = findExpectation(manifest.files, 'vectors.bin');
      if (!expected) throw new Error('manifest has no vectors.bin entry');
      await verifyFile(buf, expected, digest); // throws on mismatch
      return parseVectors(buf);
    },
    (v) => `${v.count} vectors, ${v.dim}-d, ${v.encoding}`,
  );

  checks.push({
    name: 'vectors.bin verified against manifest sha256',
    pass: true,
    detail: `${vectors.count} rows x ${vectors.dim} dims`,
  });

  // ---- 3. delta --------------------------------------------------------
  const deltaName = manifest.files.find((f) => f.name.startsWith('delta/'))?.name;
  if (!deltaName) throw new Error('manifest lists no delta artifact');

  const records = await mark(
    'download + decompress delta',
    async () => {
      const buf = await (await fetch(`/${deltaName}`)).arrayBuffer();
      const raw = decompress(new Uint8Array(buf));
      return new TextDecoder()
        .decode(raw)
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as DeltaRecord);
    },
    (r) => `${r.length} records`,
  );

  // The delta was unusable until this phase: it carried no id, no vec_index and no vector,
  // so a client could read it and still be unable to place any new paper in a feed.
  const usable = records.filter((r) => r.id !== undefined && r.vec_index !== undefined && r.vec !== undefined);
  checks.push({
    name: 'delta records carry id + vec_index + vector',
    pass: usable.length === records.length,
    detail: `${usable.length}/${records.length}`,
  });
  if (usable.length !== records.length) {
    throw new Error('delta is missing linkage fields; it cannot be consumed');
  }

  const vectorLengths = new Set(usable.slice(0, 50).map((r) => base64ToInt8(r.vec).length));
  checks.push({
    name: 'embedded delta vectors decode to the declared dimension',
    pass: vectorLengths.size === 1 && vectorLengths.has(vectors.dim),
    detail: `decoded lengths ${[...vectorLengths].join(',')} vs dim ${vectors.dim}`,
  });

  // Topics are 15% of the ranking weight via topic_overlap. They were absent from the delta
  // until this phase, which silently zeroed that component: topicEntropy measured 0.0.
  const withTopics = records.filter((r) => Array.isArray(r.topics) && r.topics.length > 0);
  checks.push({
    name: 'delta records carry topics (topic_overlap is 15% of ranking weight)',
    pass: withTopics.length > records.length * 0.5,
    detail: `${withTopics.length}/${records.length} have topics`,
  });

  // ---- 4. corpus + feed ------------------------------------------------
  const corpus = await mark(
    'build corpus',
    async () => new Corpus(records.map(toPaper), vectors),
    (c) => `${c.size} papers indexed`,
  );
  checks.push({
    name: 'every delta vec_index is in range',
    pass: corpus.papers.every((p) => p.vecIndex !== null && p.vecIndex < vectors.count),
    detail: `${corpus.papers.length} checked`,
  });

  const seeds = pickSeeds(corpus, 5);
  checks.push({
    name: 'onboarding seeds span multiple categories',
    pass: new Set(seeds.map((s) => s.primaryCategory)).size > 1,
    detail: `${seeds.length} seeds across ${new Set(seeds.map((s) => s.primaryCategory)).size} categories`,
  });

  const config: FeedConfig = configFromManifest(manifest);
  const generated = await mark(
    'generate feed',
    async () =>
      generateFeed(corpus, seeds.map((s) => s.id), config, { nowMs: Date.now(), rngSeed: 1 }),
    (r) => `${r.feed.length} items from ${r.stats.candidates} candidates`,
  );

  const quality = evaluateFeed(corpus, generated.feed, Date.now());
  checks.push({
    name: 'feed has no duplicates and excludes seeds',
    pass:
      new Set(generated.feed.map((s) => s.paper.id)).size === generated.feed.length &&
      !generated.feed.some((s) => seeds.some((x) => x.id === s.paper.id)),
    detail: `${generated.feed.length} unique items`,
  });
  checks.push({
    name: 'exploration slots honoured',
    pass: generated.feed.filter((s: Scored) => s.stage === 'exploration').length === generated.stats.exploreSlots,
    detail: `${generated.stats.exploreSlots} configured`,
  });

  const feed = generated.feed.map((s, i) => ({
    rank: i + 1,
    arxivId: s.paper.arxivId,
    title: s.paper.title,
    category: s.paper.primaryCategory,
    score: Number(s.score.toFixed(4)),
    similarity: Number(s.components.similarity.toFixed(4)),
    stage: s.stage,
  }));

  return {
    ok: true,
    stages,
    manifest: {
      generated_at: manifest.generated_at,
      corpus: manifest.corpus,
      encoding: manifest.encoding,
    },
    feed,
    quality: quality as unknown as Record<string, unknown>,
    checks,
  };
}

function render(result: HarnessResult): void {
  const el = document.getElementById('out');
  if (!el) return;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

  if (!result.ok) {
    el.innerHTML = `<h1 class="bad">HARNESS FAILED</h1><pre>${esc(result.error ?? 'unknown')}</pre>`;
    return;
  }

  const checks = result.checks
    .map((c) => `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? 'PASS' : 'FAIL'} — ${esc(c.name)} <span class="dim">(${esc(c.detail)})</span></li>`)
    .join('');
  const stages = result.stages
    .map((s) => `<li>${esc(s.name)} <span class="dim">${s.ms} ms — ${esc(s.detail)}</span></li>`)
    .join('');
  const items = (result.feed ?? [])
    .map(
      (f) =>
        `<li><b>${f.rank}. ${esc(f.title)}</b><br><span class="dim">${esc(f.category)} · score ${f.score} · sim ${f.similarity} · ${f.stage}</span></li>`,
    )
    .join('');

  el.innerHTML = `
    <h1 class="ok">HARNESS PASSED</h1>
    <h2>Checks</h2><ul>${checks}</ul>
    <h2>Stages</h2><ul>${stages}</ul>
    <h2>Feed quality</h2><pre>${esc(JSON.stringify(result.quality, null, 2))}</pre>
    <h2>Feed</h2><ul class="feed">${items}</ul>
  `;
}

declare global {
  interface Window {
    __HARNESS__?: HarnessResult;
  }
}

run()
  .then((r) => {
    window.__HARNESS__ = r;
    render(r);
  })
  .catch((e: unknown) => {
    const r: HarnessResult = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      stages: [],
      checks: [],
    };
    window.__HARNESS__ = r;
    render(r);
  });
