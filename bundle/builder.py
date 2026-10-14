"""Build the static content bundle that the mobile app downloads.

This is the whole reason no server is needed: everything read-only is precomputed here and
shipped as static files, and all personalization happens on the device.

Artifacts produced per build:
  app_bundle.db.zst     SQLite (metadata, tags, FTS5 search index), zstd-compressed
  vectors.bin           packed quantized embeddings + id mapping
  delta/<date>.jsonl.zst  papers newer than a cutoff, for incremental sync
  manifest.json         versions, checksums, counts, and remote ranking configuration

The manifest carries the ranking weights. That is deliberate: it lets the recommender be
retuned without shipping a new client, which is the main thing you give up by having no
server-side ranking.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import struct
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import psycopg
import zstandard as zstd

from dailypapers.quantize import DIM, l2_normalize, quantize_int8

VECTOR_MAGIC = b"DPV1"
SCHEMA_VERSION = 1
BUNDLE_VERSION = 1

# Default ranking configuration, shipped into the manifest so the client can be
# retuned remotely. These are deliberately readable and simple.
DEFAULT_RANKING = {
    "weights": {"similarity": 0.60, "recency": 0.25, "topic_overlap": 0.15},
    "mmr_lambda": 0.70,
    "exploration_epsilon": 0.15,
    "html_bonus": 0.05,
    "recency_halflife_days": 14.0,
    "feed_size": 20,
    "candidate_pool": 500,
}

SQLITE_SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE papers (
    id               INTEGER PRIMARY KEY,
    arxiv_id         TEXT,
    title            TEXT NOT NULL,
    abstract         TEXT,
    authors          TEXT,          -- JSON array, ordered by author position
    primary_category TEXT,
    categories       TEXT,          -- JSON array
    published_at     TEXT,          -- ISO-8601 UTC
    venue            TEXT,
    citation_count   INTEGER NOT NULL DEFAULT 0,
    oa_status        TEXT,
    html_available   INTEGER NOT NULL DEFAULT 0,
    html_url         TEXT,
    pdf_url          TEXT,
    vec_index        INTEGER        -- row offset into vectors.bin, NULL if unembedded
);

CREATE INDEX papers_published_idx ON papers (published_at DESC);
CREATE INDEX papers_category_idx  ON papers (primary_category);

CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE paper_topics (
    paper_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    score    REAL,
    PRIMARY KEY (paper_id, topic_id)
);

CREATE INDEX paper_topics_topic_idx ON paper_topics (topic_id);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE papers_fts USING fts5(
    title, abstract, content='papers', content_rowid='id', tokenize='porter unicode61'
);
"""


@dataclass
class BundleConfig:
    out_dir: Path
    window_days: int = 365
    encoding: str = "int8"          # "int8" (768 B) or "binary" (96 B)
    center: bool = True             # mean-center before quantizing; see write_vectors
    compression_level: int = 12
    with_fts: bool = True
    limit: int | None = None
    delta_since_days: int = 1
    ranking: dict = field(default_factory=lambda: json.loads(json.dumps(DEFAULT_RANKING)))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

PAPERS_SQL = """
SELECT p.id,
       p.arxiv_base_id,
       p.title,
       p.abstract,
       p.primary_category,
       p.categories,
       p.published_at,
       p.venue,
       p.citation_count,
       p.oa_status,
       p.html_available,
       p.html_url,
       p.pdf_url,
       (SELECT json_agg(a.name ORDER BY pa.position)
          FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
         WHERE pa.paper_id = p.id) AS authors,
       (SELECT json_agg(json_build_array(t.name, pt.score) ORDER BY pt.score DESC)
          FROM paper_topics pt JOIN topics t ON t.id = pt.topic_id
         WHERE pt.paper_id = p.id) AS topics
  FROM papers p
 WHERE p.published_at >= now() - make_interval(days => %(days)s)
 ORDER BY p.id
"""


def fetch_papers(conn: psycopg.Connection, config: BundleConfig) -> list[dict]:
    sql = PAPERS_SQL
    params: dict = {"days": config.window_days}
    if config.limit:
        sql += " LIMIT %(limit)s"
        params["limit"] = config.limit
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def fetch_vectors(
    conn: psycopg.Connection, paper_ids: list[int]
) -> tuple[list[int], np.ndarray]:
    """Embedded vectors for exactly the given papers, fetched in chunks.

    Scoped to the paper id set rather than re-running the window filter, so that a
    `--limit` build cannot ship vectors for papers that are absent from the SQLite file.
    Chunked because pulling every embedding as text in one query would balloon to ~1 GB at
    production corpus sizes.
    """
    ids: list[int] = []
    chunks: list[np.ndarray] = []
    for start in range(0, len(paper_ids), 5000):
        batch = paper_ids[start : start + 5000]
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, embedding::text AS emb
                  FROM papers
                 WHERE embedding IS NOT NULL AND id = ANY(%(ids)s)
                 ORDER BY id
                """,
                {"ids": batch},
            )
            rows = cur.fetchall()
        for r in rows:
            ids.append(r["id"])
            chunks.append(np.fromstring(r["emb"].strip("[]"), sep=",", dtype=np.float32))

    matrix = np.vstack(chunks) if chunks else np.zeros((0, DIM), dtype=np.float32)
    return ids, matrix


# --------------------------------------------------------------------------
# Writers
# --------------------------------------------------------------------------

def write_sqlite(papers: list[dict], vec_index: dict[int, int], path: Path, with_fts: bool) -> None:
    con = sqlite3.connect(path)
    try:
        con.executescript(SQLITE_SCHEMA)
        if with_fts:
            con.executescript(FTS_SCHEMA)

        con.executemany(
            """
            INSERT INTO papers (id, arxiv_id, title, abstract, authors, primary_category,
                                categories, published_at, venue, citation_count, oa_status,
                                html_available, html_url, pdf_url, vec_index)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            [
                (
                    p["id"],
                    p["arxiv_base_id"],
                    p["title"],
                    p["abstract"],
                    json.dumps(p["authors"] or []),
                    p["primary_category"],
                    json.dumps(p["categories"] or []),
                    p["published_at"].isoformat() if p["published_at"] else None,
                    p["venue"],
                    p["citation_count"] or 0,
                    p["oa_status"],
                    1 if p["html_available"] else 0,
                    p["html_url"],
                    p["pdf_url"],
                    vec_index.get(p["id"]),
                )
                for p in papers
            ],
        )

        topic_ids: dict[str, int] = {}
        links: list[tuple[int, int, float]] = []
        for p in papers:
            for name, score in p["topics"] or []:
                if name not in topic_ids:
                    topic_ids[name] = len(topic_ids) + 1
                links.append((p["id"], topic_ids[name], score))

        con.executemany(
            "INSERT INTO topics (id, name) VALUES (?,?)",
            [(tid, name) for name, tid in topic_ids.items()],
        )
        con.executemany(
            "INSERT INTO paper_topics (paper_id, topic_id, score) VALUES (?,?,?)", links
        )

        con.executemany(
            "INSERT INTO meta (key, value) VALUES (?,?)",
            [
                ("schema_version", str(SCHEMA_VERSION)),
                ("generated_at", _now()),
                ("papers", str(len(papers))),
                ("topics", str(len(topic_ids))),
            ],
        )

        if with_fts:
            con.execute("INSERT INTO papers_fts(papers_fts) VALUES ('rebuild')")

        con.commit()
    finally:
        con.close()


def write_vectors(
    path: Path,
    ids: list[int],
    matrix: np.ndarray,
    encoding: str,
    centroid: np.ndarray | None = None,
) -> dict:
    """Write the packed vector file.

    **Vectors are mean-centered before quantization.** SPECTER2 embeddings are severely
    anisotropic: measured across this corpus the mean vector has norm 0.919, so raw cosine
    sits in a narrow band (p5..p95 spread of only 0.114). Ranking on that band makes tiny
    differences decide the order, and MMR has nothing to work with. Centering widens the
    spread to 0.565 -- a 4.9x improvement -- and is baked into the quantized codes so the
    device needs no extra work at query time.

    The centroid is appended to the file and recorded in the manifest so that lazily
    fetched older shards can be centered with the *same* reference and stay comparable.

    The layout is fixed regardless of encoding -- a scales array is always present, even
    for binary where it is uniformly 1.0 -- so the client has one parser rather than two.
    """
    if centroid is None:
        centroid = matrix.mean(axis=0) if len(matrix) else np.zeros(DIM, dtype=np.float32)
    centroid = np.asarray(centroid, dtype=np.float32).reshape(DIM)
    centered = l2_normalize(matrix - centroid) if len(matrix) else matrix

    if encoding != "int8":
        # Binary was removed rather than repaired. `pack_binary` emits 96 bytes per row
        # while the header declares dim=768, so a binary bundle could be *written* but
        # never read back -- and it was measurably worse anyway (78.5% vs 99.8% recall@20
        # after centering). A broken, unused option costs more than the optionality is
        # worth. `pack_binary` stays in dailypapers/quantize.py for the evaluation harness.
        raise ValueError(
            f"unsupported encoding {encoding!r}: only 'int8' is supported. "
            "Binary quantization is kept only in dailypapers/quantize.py for evaluation."
        )
    codes, scales = quantize_int8(centered)
    code_dtype = np.int8

    header = {
        "encoding": encoding,
        "count": int(len(ids)),
        "dim": DIM,
        "code_dtype": np.dtype(code_dtype).name,
        "normalized": True,
        "centered": True,
        "layout": [
            "magic:4s",
            "header_len:uint32<",
            "header:json-utf8",
            "ids:int64<[count]",
            "scales:float32<[count]",
            f"codes:{np.dtype(code_dtype).name}[count,dim]",
            "centroid:float32<[dim]",
        ],
    }
    header_bytes = json.dumps(header, separators=(",", ":")).encode()

    with path.open("wb") as f:
        f.write(VECTOR_MAGIC)
        f.write(struct.pack("<I", len(header_bytes)))
        f.write(header_bytes)
        f.write(np.asarray(ids, dtype="<i8").tobytes())
        f.write(np.asarray(scales, dtype="<f4").tobytes())
        f.write(np.ascontiguousarray(codes, dtype=code_dtype).tobytes())
        f.write(centroid.astype("<f4").tobytes())

    bytes_per_paper = int(codes.shape[1] * np.dtype(code_dtype).itemsize) + 12  # +scale +id
    info = {
        "encoding": encoding,
        "dim": DIM,
        "count": int(len(ids)),
        "centered": True,
        "bytes_per_paper": bytes_per_paper,
        "bytes_per_paper_vectors_only": int(codes.shape[1] * np.dtype(code_dtype).itemsize),
    }
    # Codes and scales are returned as well so write_delta can embed the same quantized
    # vectors it just wrote, rather than quantizing a second time.
    return info, codes, scales


def write_delta(
    conn: psycopg.Connection,
    path: Path,
    since_days: int,
    level: int,
    vectors: tuple[dict[int, int], np.ndarray, np.ndarray] | None = None,
) -> int:
    """Newline-delimited JSON of papers newer than the cutoff, for incremental sync.

    Each record carries its own quantized vector and its row offset, not just metadata.
    Without `id`, `vec_index` and the vector, a client can download a delta and still be
    unable to use any of it: there is no way to link a new paper to an embedding, so new
    papers can never enter a feed. The format shipped that way for a phase because nothing
    had ever consumed it.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.arxiv_base_id AS arxiv_id, p.title, p.abstract,
                   p.primary_category, p.categories, p.published_at, p.venue,
                   p.citation_count, p.html_available, p.html_url, p.pdf_url,
                   (SELECT json_agg(a.name ORDER BY pa.position)
                      FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
                     WHERE pa.paper_id = p.id) AS authors,
                   (SELECT json_agg(json_build_array(t.name, pt.score) ORDER BY pt.score DESC)
                      FROM paper_topics pt JOIN topics t ON t.id = pt.topic_id
                     WHERE pt.paper_id = p.id) AS topics
              FROM papers p
             WHERE p.published_at >= now() - make_interval(days => %(days)s)
             ORDER BY p.published_at
            """,
            {"days": since_days},
        )
        rows = cur.fetchall()

    vec_index_map, codes, scales = vectors if vectors else ({}, None, None)

    # One-shot, not streamed: see compress(). Deltas are small, so this is cheap and it
    # keeps every artifact in the bundle parseable by the same client decompressor.
    lines = []
    for r in rows:
        record = {
            **r,
            "published_at": r["published_at"].isoformat() if r["published_at"] else None,
        }
        row = vec_index_map.get(r["id"])
        if row is not None and codes is not None:
            record["vec_index"] = row
            record["scale"] = float(scales[row])
            record["vec"] = base64.b64encode(
                np.asarray(codes[row], dtype=np.int8).tobytes()
            ).decode("ascii")
        lines.append(json.dumps(record, separators=(",", ":")))

    payload = ("\n".join(lines) + "\n").encode() if lines else b""
    path.write_bytes(
        zstd.ZstdCompressor(
            level=level, write_content_size=True, write_checksum=True
        ).compress(payload)
    )
    return len(rows)


def validate_artifacts(out: Path) -> dict:
    """Read every artifact back and assert it is internally consistent.

    This exists because the builder shipped a broken binary encoding for a whole phase: it
    wrote the file and reported success, but the artifact could never be read. Anything
    that *can* be validated by reading it back should be, because a build nobody can
    consume is worse than a build that fails loudly.

    Raises ValueError on any inconsistency.
    """
    vf = read_vectors(out / "vectors.bin")
    count, dim = vf.header["count"], vf.header["dim"]

    if count != len(vf.ids):
        raise ValueError(f"header count {count} != {len(vf.ids)} ids")
    if count != len(vf.scales):
        raise ValueError(f"header count {count} != {len(vf.scales)} scales")
    if vf.codes.shape != (count, dim):
        raise ValueError(
            f"codes shape {vf.codes.shape} != ({count}, {dim}): "
            "the encoding and the declared dim disagree"
        )
    if len(vf.centroid) != dim:
        raise ValueError(f"centroid has {len(vf.centroid)} dims, expected {dim}")
    if len(set(vf.ids.tolist())) != count:
        raise ValueError("duplicate paper ids in vectors.bin")
    if count and vf.ids.min() <= 0:
        raise ValueError("non-positive paper id in vectors.bin")

    # Every compressed artifact must declare its content size, or a client decompressor
    # cannot preallocate and some reject the frame outright.
    sizes: dict[str, int] = {}
    for zst_path in sorted(out.rglob("*.zst")):
        declared = zstd.frame_content_size(zst_path.read_bytes())
        if declared <= 0:
            raise ValueError(f"{zst_path.name} does not declare a content size")
        sizes[str(zst_path.relative_to(out))] = declared

    return {
        "count": count,
        "dim": dim,
        "encoding": vf.header["encoding"],
        "decompressed_sizes": sizes,
    }


def compress(src: Path, dst: Path, level: int) -> None:
    """Compress a whole file in one shot.

    One-shot matters here. `copy_stream` produces a frame with no content-size field, so a
    client decompressor cannot preallocate its output buffer -- and a decompressor that
    requires the size upfront rejects the frame outright. Measured: fzstd (pure JS, the
    Hermes-compatible decompressor) runs at ~60 MB/s on these frames either way, but
    without a declared size it must grow the buffer dynamically.
    """
    cctx = zstd.ZstdCompressor(level=level, write_content_size=True, write_checksum=True)
    dst.write_bytes(cctx.compress(src.read_bytes()))


@dataclass
class VectorFile:
    """Parsed contents of vectors.bin."""

    header: dict
    ids: np.ndarray          # int64[count] -> papers.id
    scales: np.ndarray       # float32[count]
    codes: np.ndarray        # int8|uint8[count, dim]
    centroid: np.ndarray     # float32[dim] subtracted before quantization


def read_vectors(path: Path) -> VectorFile:
    """Reference parser for vectors.bin.

    Kept next to the writer on purpose: it doubles as the executable specification of the
    format, so the client implementations (Dart/Swift) have something to check against.
    """
    with path.open("rb") as f:
        magic = f.read(4)
        if magic != VECTOR_MAGIC:
            raise ValueError(f"bad magic {magic!r}, expected {VECTOR_MAGIC!r}")
        (header_len,) = struct.unpack("<I", f.read(4))
        header = json.loads(f.read(header_len))
        count, dim = header["count"], header["dim"]
        ids = np.frombuffer(f.read(8 * count), dtype="<i8").copy()
        scales = np.frombuffer(f.read(4 * count), dtype="<f4").copy()
        code_dtype = np.dtype(header["code_dtype"])
        codes = np.frombuffer(f.read(code_dtype.itemsize * count * dim), dtype=code_dtype)
        codes = codes.reshape(count, dim).copy()
        centroid = np.frombuffer(f.read(4 * dim), dtype="<f4").copy()
    return VectorFile(header=header, ids=ids, scales=scales, codes=codes, centroid=centroid)


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------

def build(conn: psycopg.Connection, config: BundleConfig) -> dict:
    out = config.out_dir
    delta_dir = out / "delta"
    delta_dir.mkdir(parents=True, exist_ok=True)
    # Clear stale deltas. They were accumulating across builds -- every previous day's file
    # stayed on disk and got swept into the manifest's file list and size total.
    for stale in delta_dir.glob("*.jsonl.zst"):
        stale.unlink()

    papers = fetch_papers(conn, config)
    if not papers:
        raise SystemExit("no papers matched the window; crawl something first")

    vec_ids, matrix = fetch_vectors(conn, [p["id"] for p in papers])
    vec_index = {pid: i for i, pid in enumerate(vec_ids)}

    raw_db = out / "_app_bundle.db"
    write_sqlite(papers, vec_index, raw_db, config.with_fts)

    db_path = out / "app_bundle.db.zst"
    compress(raw_db, db_path, config.compression_level)
    raw_db.unlink()

    vec_path = out / "vectors.bin"
    # A zero centroid makes centering a no-op, which is how --no-center is implemented.
    if len(matrix) and config.center:
        centroid = matrix.mean(axis=0)
    else:
        centroid = np.zeros(DIM, dtype=np.float32)
    encoding_info, codes, scales = write_vectors(
        vec_path, vec_ids, matrix, config.encoding, centroid
    )

    delta_path = out / "delta" / f"{datetime.now(timezone.utc):%Y-%m-%d}.jsonl.zst"
    delta_count = write_delta(
        conn,
        delta_path,
        config.delta_since_days,
        config.compression_level,
        (vec_index, codes, scales),
    )

    files = []
    for p in (db_path, vec_path, delta_path):
        files.append(
            {
                "name": str(p.relative_to(out)),
                "bytes": p.stat().st_size,
                "sha256": _sha256(p),
            }
        )

    with_html = sum(1 for p in papers if p["html_available"])
    published = [p["published_at"] for p in papers if p["published_at"]]

    manifest = {
        "bundle_version": BUNDLE_VERSION,
        "schema_version": SCHEMA_VERSION,
        "generated_at": _now(),
        "window_days": config.window_days,
        "corpus": {
            "papers": len(papers),
            "with_embeddings": len(vec_ids),
            "with_html": with_html,
            "html_coverage": round(with_html / len(papers), 4) if papers else 0.0,
            "date_min": min(published).isoformat() if published else None,
            "date_max": max(published).isoformat() if published else None,
            "delta_papers": delta_count,
            "delta_since_days": config.delta_since_days,
        },
        "encoding": encoding_info,
        # Vectors are mean-centered before quantization (see write_vectors). The centroid
        # is recorded so lazily fetched older shards can be centered with the same
        # reference and stay comparable to this bundle.
        "vectors": {
            "centered": True,
            "centroid_norm": round(float(np.linalg.norm(centroid)), 4),
        },
        "files": files,
        "total_bytes": sum(f["bytes"] for f in files),
        # Remote ranking configuration: retune the recommender without an app release.
        "ranking": config.ranking,
    }

    # Read the artifacts back before publishing. A build that cannot be consumed must fail
    # here, in the build job, rather than on a user's phone.
    manifest["validation"] = validate_artifacts(out)

    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    return manifest
