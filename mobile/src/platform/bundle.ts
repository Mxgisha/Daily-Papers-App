/**
 * Bundle acquisition and loading.
 *
 * The client's whole content layer: download the static artifacts, decompress, open SQLite,
 * parse the packed vectors, and hand the feed a `Corpus`.
 *
 * Compression choice is measured, not assumed. zstd is kept over gzip because pure-JS
 * decompression speed is identical (`fzstd` and `pako` both hit ~60 MB/s on the real
 * bundle) while zstd produces a 13% smaller download. `fzstd` is decompression-only with no
 * native or WASM dependency, so it works under Hermes -- which does not support WebAssembly
 * and therefore rules out the usual `zstd-wasm` packages.
 *
 * NOTE: this module talks to device APIs and is deliberately outside the Node test suite.
 * The bundle *format* and the *feed* logic it feeds are verified in tests/; the file and
 * SQLite I/O here still needs a real device or simulator to confirm.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { decompress } from 'fzstd';
import { sha256 } from 'js-sha256';

import { Corpus, type Paper } from '../core/feed';
import {
  type Digest,
  findExpectation,
  verifyFile,
  verifySize,
} from '../core/integrity';
import { parseVectors, type VectorFile } from '../core/vectors';

/**
 * Pure-JS SHA-256. Chosen over a native crypto module deliberately: it works identically on
 * device and on the web target, so the integrity path can be exercised in a browser rather
 * than only on a phone. `verifyFile` accepts an injected digest so tests supply Node's.
 */
const digest: Digest = async (data) => sha256(new Uint8Array(data));

const DB_NAME = 'bundle.db';
const VECTORS_NAME = 'vectors.bin';
const MANIFEST_NAME = 'manifest.json';

export interface Manifest {
  bundle_version: number;
  schema_version: number;
  generated_at: string;
  window_days: number;
  corpus: {
    papers: number;
    with_embeddings: number;
    with_html: number;
    html_coverage: number;
    date_min: string | null;
    date_max: string | null;
  };
  encoding: { encoding: string; count: number; dim: number; centered?: boolean };
  files: { name: string; bytes: number; sha256: string }[];
  total_bytes: number;
  ranking: Record<string, unknown>;
}

export interface BundlePaths {
  dir: Directory;
  db: File;
  vectors: File;
  manifest: File;
}

export function bundlePaths(): BundlePaths {
  const dir = new Directory(Paths.document, 'bundle');
  if (!dir.exists) dir.create({ intermediates: true });
  return {
    dir,
    db: new File(dir, DB_NAME),
    vectors: new File(dir, VECTORS_NAME),
    manifest: new File(dir, MANIFEST_NAME),
  };
}

export function isInstalled(): boolean {
  const p = bundlePaths();
  return p.db.exists && p.vectors.exists && p.manifest.exists;
}

export async function installedManifest(): Promise<Manifest | null> {
  const { manifest } = bundlePaths();
  if (!manifest.exists) return null;
  try {
    return JSON.parse(await manifest.text()) as Manifest;
  } catch {
    return null;
  }
}

export function clearBundle(): void {
  const p = bundlePaths();
  for (const f of [p.db, p.vectors, p.manifest]) {
    if (f.exists) f.delete();
  }
}

async function downloadTo(url: string, destination: File): Promise<void> {
  if (destination.exists) destination.delete();
  await File.downloadFileAsync(url, destination);
  if (!destination.exists) {
    throw new Error(`download produced no file for ${url}`);
  }
}

/**
 * One-shot decompression.
 *
 * `fzstd` allocates the entire output, so peak memory is roughly the decompressed bundle
 * size. At the recommended 90-day window that is fine; a full-year bundle would want
 * `fzstd`'s streaming `Decompress` class instead.
 */
function decompressToBytes(compressed: ArrayBuffer): Uint8Array {
  return decompress(new Uint8Array(compressed));
}

async function writeBytes(file: File, bytes: Uint8Array): Promise<void> {
  if (file.exists) file.delete();
  file.create();
  const writer = file.writableStream().getWriter();
  await writer.write(bytes);
  await writer.close();
}

export interface InstallProgress {
  (stage: string, fraction: number): void;
}

/** Download and install the bundle when the remote build differs from the local one. */
export async function installBundle(
  baseUrl: string,
  onProgress: InstallProgress = () => {},
): Promise<Manifest> {
  const base = baseUrl.replace(/\/$/, '');
  const paths = bundlePaths();

  onProgress('checking', 0);
  const remoteFile = new File(Paths.cache, MANIFEST_NAME);
  await downloadTo(`${base}/${MANIFEST_NAME}`, remoteFile);
  const remote = JSON.parse(await remoteFile.text()) as Manifest;

  const local = await installedManifest();
  if (local && local.generated_at === remote.generated_at && paths.db.exists) {
    onProgress('up to date', 1);
    return local;
  }

  onProgress('downloading database', 0.1);
  const compressed = new File(Paths.cache, `${DB_NAME}.zst`);
  await downloadTo(`${base}/app_bundle.db.zst`, compressed);

  onProgress('decompressing database', 0.5);
  const compressedBytes = await compressed.arrayBuffer();
  const expectDb = findExpectation(remote.files, 'app_bundle.db.zst');
  if (expectDb) {
    // Size only. The zstd frame carries a content checksum that the decoder verifies, so
    // hashing here would repeat work the decompressor already did.
    verifySize(compressedBytes, expectDb);
  }
  const raw = decompressToBytes(compressedBytes);
  await writeBytes(paths.db, raw);
  if (compressed.exists) compressed.delete();

  onProgress('verifying vectors', 0.8);
  await downloadTo(`${base}/${VECTORS_NAME}`, paths.vectors);
  const expectVectors = findExpectation(remote.files, VECTORS_NAME);
  if (expectVectors) {
    // Full checksum here, unlike the database. A corrupted vectors.bin does not throw --
    // it silently produces wrong recommendations, which is the worst failure mode this
    // client has and the only one worth paying a hash for.
    await verifyFile(await paths.vectors.arrayBuffer(), expectVectors, digest);
  }

  await writeBytes(paths.manifest, new TextEncoder().encode(JSON.stringify(remote)));
  onProgress('done', 1);
  return remote;
}

// --------------------------------------------------------------------------
// Loading
// --------------------------------------------------------------------------

interface PaperRow {
  id: number;
  arxiv_id: string | null;
  title: string;
  abstract: string | null;
  primary_category: string | null;
  categories: string | null;
  published_at: string | null;
  html_available: number;
  citation_count: number;
  vec_index: number | null;
}

function parseIso(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Read paper rows and topic links out of the bundle SQLite file. */
export async function loadPapers(db: SQLite.SQLiteDatabase): Promise<Paper[]> {
  const rows = await db.getAllAsync<PaperRow>(
    `SELECT id, arxiv_id, title, abstract, primary_category, categories,
            published_at, html_available, citation_count, vec_index
       FROM papers`,
  );

  const topicRows = await db.getAllAsync<{ paper_id: number; name: string }>(
    `SELECT pt.paper_id AS paper_id, t.name AS name
       FROM paper_topics pt JOIN topics t ON t.id = pt.topic_id`,
  );
  const topicsByPaper = new Map<number, string[]>();
  for (const t of topicRows) {
    const list = topicsByPaper.get(t.paper_id);
    if (list) list.push(t.name);
    else topicsByPaper.set(t.paper_id, [t.name]);
  }

  return rows.map((r) => ({
    id: r.id,
    arxivId: r.arxiv_id ?? '',
    title: r.title,
    abstract: r.abstract ?? '',
    primaryCategory: r.primary_category ?? '',
    categories: r.categories ? (JSON.parse(r.categories) as string[]) : [],
    topics: topicsByPaper.get(r.id) ?? [],
    publishedAt: parseIso(r.published_at),
    htmlAvailable: r.html_available === 1,
    citationCount: r.citation_count ?? 0,
    // vec_index is the row offset into vectors.bin, NOT a paper id.
    vecIndex: r.vec_index,
  }));
}

export interface LoadedBundle {
  corpus: Corpus;
  vectors: VectorFile;
  manifest: Manifest;
}

/** Open the installed bundle and build the corpus the feed runs against. */
export async function loadBundle(): Promise<LoadedBundle> {
  const paths = bundlePaths();
  if (!paths.db.exists || !paths.vectors.exists) {
    throw new Error('bundle not installed; call installBundle() first');
  }

  const manifest = await installedManifest();
  if (!manifest) throw new Error('bundle manifest missing or unreadable');

  const vectors = parseVectors(await paths.vectors.arrayBuffer());

  const db = await SQLite.openDatabaseAsync(paths.db.uri);
  try {
    const papers = await loadPapers(db);
    return { corpus: new Corpus(papers, vectors), vectors, manifest };
  } finally {
    await db.closeAsync();
  }
}
