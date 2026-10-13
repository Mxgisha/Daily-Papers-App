# Daily Papers App

A mobile-first research paper reader with a daily personalized feed, progress sync,
favorites/collections, and a recommendation system that learns the user.

See **[PLAN.md](PLAN.md)** for the full strategy and stack rationale.

## Architecture: static bundle, on-device personalization, no server

Read-only content is precomputed and shipped as static files; all personalization runs on
the device. The only central component is a small managed store for identity and telemetry.

```
  nightly job (GitHub Action, free)  ──  reuses ingest/ + SPECTER2 on CPU
        │
        ├─ app_bundle.db.zst      SQLite: metadata, tags, FTS5 search index
        ├─ vectors.bin            packed int8 embeddings + id mapping
        ├─ delta/<date>.jsonl.zst new papers for incremental sync
        └─ manifest.json          checksums + remote ranking configuration
                    ↓
        Cloudflare R2 / any CDN — files only, no logic
                    ↓
  ┌────────────────── Expo app (offline-first) ──────────────────┐
  │  SQLite corpus + local progress/favorites/collections         │
  │  On-device scoring → MMR → ε-greedy exploration               │
  │  Local scheduled notifications                                │
  └───────────────────────────────────────────────────────────────┘
                    ↓ batched, idempotent, when online
        managed Postgres (Supabase free tier) — auth + events only
```

There is no FastAPI, no Redis, and no server process to operate. **Infra cost at MVP is
$0/month**; the only unavoidable spend is Apple's $99/year when you ship to iOS.

## Status

Phase 0 (validation) and the Phase 1 data layer are done and verified.

### The headline finding: ship int8, not binary

The bundle cannot ship float32 vectors — 3,072 B/paper is 382 MB across a 12-month corpus
(measured: 130,458 papers). So the vectors must be compressed, and the question is what
that compression costs in ranking quality. Measured against exact float32 ranking on
**1,633 real SPECTER2 vectors**:

| K | binary (96 B) | binary → exact rescore | int8 (768 B) | int8 → rescore |
|---|---|---|---|---|
| 10 | 62.2% | 100.0% | 94.3% | 100.0% |
| 20 | **63.7%** | 100.0% | **95.3%** | 100.0% |
| 50 | 67.6% | 99.9% | 95.9% | 100.0% |
| 100 | 70.5% | 99.5% | 96.7% | 100.0% |

Spearman correlation with exact cosine: **binary 0.910, int8 0.999**.

**I assumed binary (one sign bit per dimension) would be good enough. It is not** — it
discards a third of a feed page at K=20, and it *degrades as the corpus grows* (70.5% at
n=336, 63.7% at n=1,633). int8 costs 8× the bytes but holds at 95%+.

Note the rescore column: binary is an excellent *shortlist generator* (100% of true top-20
survive in its top-500) but a poor final ranker. That matters only if you were to ship both
encodings, which costs more than int8 alone.

Re-run with `python3 -m eval.quantization_recall --source db`. Full output in
[reports/quantization_recall.md](reports/quantization_recall.md).

### Bundle sizing

Using measured constants — 1,671 B/paper metadata, int8 at 780 B/paper, zstd at ~34% of raw:

| Window | Papers | Metadata (zstd) | int8 vectors | Total |
|---|---|---|---|---|
| 90 days | ~40,700 | ~23 MB | ~32 MB | **~55 MB** |
| 180 days | ~81,400 | ~46 MB | ~63 MB | ~110 MB |
| 365 days | ~130,500 | ~74 MB | ~102 MB | ~176 MB |

**Recommended: ship 90 days (~55 MB) and lazy-fetch older months as static shards.** A
12-month bundle is too large for a first-launch download; 90 days covers the window the
daily feed actually draws from, and search can range over fetched shards.

### Embedding throughput

SPECTER2 on the CPU available here: **~2.6 papers/sec** (1,633 papers in 8m28s). The daily
delta of ~450 papers is ~3 minutes, which is fine. A full 130k backfill would be **~14
hours**, so the initial corpus build wants a GPU or a cloud CPU instance. Obvious speedups
if needed: length-bucketed batching (abstracts are padded to 512 tokens, wasting compute on
short ones), reducing `max_length` to 256, or ONNX Runtime dynamic quantization.

### Reader

Measured HTML full-text coverage across 1,633 recent papers: **96.4%** (and 87.2%
historically back to 2017). PDF is a ~4% fallback path, not a co-equal workstream.

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
docker compose up -d postgres              # Postgres 17 + pgvector on localhost:5433

.venv/bin/python -m ingest init-db         # schema + migrations (idempotent)
.venv/bin/python -m ingest crawl --per-category 100
.venv/bin/python -m ingest embed           # SPECTER2 → Postgres (needs torch)
.venv/bin/python -m ingest stats

.venv/bin/python -m bundle build --out dist --encoding int8
.venv/bin/python -m bundle verify  dist    # checksums + a real nearest-neighbour round trip
.venv/bin/python -m eval.quantization_recall --source db
```

Every write is an upsert, so all commands are safe to re-run. `ingest embed --embedder hashing`
substitutes a deterministic offline stand-in so the pipeline can be exercised without a
~2 GB torch install and a 440 MB model download.

## Bundle artifacts

| File | Contents |
|---|---|
| `app_bundle.db.zst` | SQLite: `papers`, `topics`, `paper_topics`, `meta`, plus an FTS5 index over title+abstract for **offline full-text search**. zstd-compressed at ~34% of raw. |
| `vectors.bin` | Packed quantized embeddings, aligned to `papers.vec_index`. |
| `delta/<date>.jsonl.zst` | Papers newer than a cutoff, for incremental sync. |
| `manifest.json` | Versions, SHA-256 per file, corpus stats, and **the ranking configuration**. |

### `vectors.bin` format

The layout is fixed across encodings — a `scales` array is always present (uniformly 1.0 for
binary) — so a client needs one parser, not two. `read_vectors()` in
[bundle/builder.py](bundle/builder.py) is the reference implementation and doubles as the
executable specification:

```
magic           4 bytes   "DPV1"
header_len      uint32<   length of the JSON header
header          JSON      encoding, count, dim, code_dtype, layout
ids             int64<    [count]     maps row → papers.id
scales          float32<  [count]     per-vector scale (1.0 for binary)
codes           int8/uint8[count, dim]
```

Approximate cosine for int8 is `(codes @ query) * scales`, using the exact float32 query.

### Remote ranking configuration

`manifest.json` carries the ranking weights (`similarity`, `recency`, `topic_overlap`,
`mmr_lambda`, `exploration_epsilon`, `html_bonus`, `recency_halflife_days`). This is
deliberate: with no server-side ranking, it is the only way to retune the recommender
without shipping a new client build, and it enables cohort-based A/B by manifest version.

## Design notes

Two schema decisions are load-bearing:

- **`papers` models the work; `paper_versions` models the arXiv submission.** A preprint and
  its published version are one work with two versions. Without this split the feed shows the
  same paper twice and splits the engagement signal that trains the recommender.
- **`feed_impressions` is not optional.** Without logged impressions you cannot distinguish
  "the user ignored this" from "the user never saw it because we ranked it 90th". Every
  offline evaluation depends on it, and it cannot be backfilled. The same reasoning drives
  `events.client_event_id UNIQUE`: mobile clients batch and retry, so without an idempotency
  key you silently double-count engagement and poison the training data.

Two operational gotchas discovered the hard way:

- **An HTTP `200` from `arxiv.org/html/{id}` is not evidence of full text.** arXiv serves a
  styled error page, and the abs page is itself HTML. Detection requires the LaTeXML
  `ltx_page_content` marker (see [dailypapers/coverage.py](dailypapers/coverage.py)).
- **`adapters` 1.3.0 logs "There are adapters available but none are activated for the
  forward pass" on every forward, including when the adapter is active.** Verified by toggling
  `set_active_adapters`: outputs change (cosine 0.959 vs base), so the proximity adapter *is*
  applied and the warning is spurious. Do not "fix" it by changing the loading code.

## Being a good citizen

arXiv asks for ≤1 request every 3 seconds on its query API and discourages aggressive
crawling. The client enforces a per-host minimum interval across a small thread pool, sends
an identifying `User-Agent`, backs off exponentially on `429`/`5xx`, and caches every
response to disk, so re-runs do not re-hit the APIs.

Only open-access content is ingested and rehosted; paywalled papers are deep-linked, never
mirrored.

## Layout

```
dailypapers/            Core package (shared by ingest, bundle, eval)
  http.py               Polite HTTP client: per-host limiting, retries, disk cache
  arxiv.py              arXiv API client: Atom parsing, identity, date-range queries
  openalex.py           OpenAlex enrichment via arXiv DOI
  coverage.py           HTML full-text detection (status + LaTeXML marker)
  embed.py              SPECTER2 embedder (+ offline hashing stand-in)
  quantize.py           int8 / binary quantization, Hamming, top-k
  db.py                 Connection, schema, migrations, idempotent upserts
  config.py             Env-driven settings (stdlib .env loader)
ingest/                 Production pipeline: crawl | embed | init-db | migrate | stats
bundle/                 Static bundle builder, reference vector reader, verifier
eval/                   Offline evaluation (quantization recall)
spike/                  Phase 0 coverage analysis (stdlib only)
db/schema.sql           Base schema
db/migrations/          Numbered, tracked in schema_migrations
docker-compose.yml      Postgres 17 + pgvector on host port 5433
```
