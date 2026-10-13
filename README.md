# Daily Papers App

A mobile-first research paper reader with a daily personalized feed, progress sync,
favorites/collections, and a recommendation system that learns the user.

See **[PLAN.md](PLAN.md)** for strategy and stack rationale.

## Architecture: static bundle, on-device personalization, no server

Read-only content is precomputed and shipped as static files; all personalization runs on
the device. The only central component is a small managed store for identity and telemetry.

```
  nightly job (GitHub Action, free)  ──  reuses ingest/ + SPECTER2 on CPU
        │
        ├─ app_bundle.db.zst      SQLite: metadata, tags, FTS5 search index
        ├─ vectors.bin            packed, mean-centered int8 embeddings + id map
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

No FastAPI, no Redis, no server process to operate. **Infra cost at MVP is $0/month**; the
only unavoidable spend is Apple's $99/year when shipping to iOS.

## Status

Phases 0 and 1 are done and verified, plus reader and feed feasibility spikes.

| What | Result |
|---|---|
| HTML full text, recent papers | **96.4%** (87% back to 2017) |
| OpenAlex enrichment, same-day preprints | **99.7%**, zero lag |
| Best vector encoding | **int8: 99.8% recall@20** after centering (binary: 78.5%) |
| Reflowed reading at 390×844 | **viable** — zero page overflow, 91 screens for a 15k-word paper |
| Feed diversity after centering | pairwise similarity **0.856 → 0.154** |

## The two findings that reshaped the design

### 1. SPECTER2 is severely anisotropic — center the vectors

Raw SPECTER2 cosine is nearly useless as a ranking signal. Measured across the corpus, the
**mean vector has norm 0.919**, and pairwise cosine sits in a narrow band:

| | raw cosine | mean-centered |
|---|---|---|
| pairwise cosine spread (p5–p95) | **0.114** | **0.565** |
| int8 recall@20 vs exact | 95.3% | **99.8%** |
| binary recall@20 vs exact | 63.7% | 78.5% |

Because the spread was only 0.114, ranking was decided by tiny differences and MMR had
nothing to work with — the first feed generated was **85.6% mean pairwise similar** and
10/20 papers were from one category. Centering (`normalize(v - centroid)`) is now applied
**before quantization at bundle-build time**, so the device pays nothing at query time. The
centroid is stored in `vectors.bin` and the manifest so lazily fetched older shards stay
comparable.

Effect on feed quality, same seeds and config:

| metric | before | after |
|---|---|---|
| mean pairwise similarity | 0.856 | **0.154** |
| distinct categories | 5 | **8** |
| topic entropy (normalized) | 0.738 | **0.955** |

### 2. Figures, not text, are the real payload

Measured on one 15,028-word paper:

| | size |
|---|---|
| arXiv page HTML | 423 KB |
| extracted article | 388 KB (91.6% of the page) |
| **62 figure images** | **28.0 MB** (largest single figure 710 KB) |

The figures are **72× the article text**. Stripping arXiv's chrome saves only 8%; the win is
layout, not bytes. This makes lazy loading and server-side figure downscaling a requirement
rather than a nicety, and it is the number that should drive any offline-caching budget.

## Quantization: ship int8, not binary

| K | binary (96 B) | int8 (768 B) |
|---|---|---|
| 10 | 77.5% | 99.7% |
| **20** | **78.5%** | **99.8%** |
| 100 | 83.1% | 99.8% |

Spearman vs exact cosine: int8 **1.000**, binary 0.94. Binary was the expected choice
(32× smaller) and it is wrong: it discards a fifth of a feed page, and it degrades as the
corpus grows. Re-run with `python3 -m eval.quantization_recall --source db`; full output in
[reports/quantization_recall.md](reports/quantization_recall.md).

### Bundle sizing

Using measured constants (1,671 B/paper metadata, 780 B/paper int8, zstd ~34% of raw):

| Window | Papers | Metadata | Vectors | Total |
|---|---|---|---|---|
| 90 days | ~40,700 | ~23 MB | ~32 MB | **~55 MB** |
| 365 days | ~130,500 | ~74 MB | ~102 MB | ~176 MB |

**Ship 90 days (~55 MB) and lazy-fetch older months as static shards.** Note that the figure
payload above is separate and unbounded — it must be streamed and cached, not bundled.

## The reader

`python3 -m reader serve` opens a local reader; `python3 -m reader shot <id>` measures it.
The extractor and CSS are the parts that carry over to the real client.

What it does: extracts `<article class="ltx_document">` from arXiv HTML, drops arXiv's
desktop CSS, and re-lays it out for one column with sticky controls, font scaling, and dark
mode. Math is **native MathML** (403 elements on the test paper) so no MathJax is needed.

Verified against real browsers, not assumed:

- **Chromium's `--window-size` clamps the layout viewport to a 500px minimum.** A 390px
  headless screenshot is a 500px layout rendered into a 390px image, which silently
  invalidates reflow and overflow measurements. `reader/driver.py` uses WebDriver
  mobile emulation to get a genuine 390×844 viewport.
- After fixing equation-table overflow, **page-level horizontal overflow is zero** at 390px.
- 15,028 words is **~91 screens**. Long papers need progress affordances, not just scroll.
- Layout gotchas fixed along the way: per-author contact blocks interleaved with names (the
  gaps are literal em-space spans, not a text-align problem), and wide tables — including
  LaTeXML's `ltx_equation` tables — each need their own horizontal scroller.

Tradeoff recorded in the CSS: suppressing per-author notes also drops affiliations. The real
client should parse the note block and render unique affiliations once below the byline.

## The feed

`python3 -m recsys feed --seeds <ids...>` runs the pipeline the client will run:

```
seeds → user vector → candidate pool → score → MMR diversify → ε-explore → feed
```

Weights come from `manifest.json`, so the recommender can be retuned without shipping a
client. The CLI prints each item's score components and per-stage attribution, so a bad feed
can be blamed on a specific stage rather than guessed at. It loads from the **built bundle**,
which means it also exercises the real `vectors.bin` parser and id mapping.

Quality is reported as proxies, because without users there is no ground truth: pairwise
redundancy, category spread, normalized topic entropy, freshness, and HTML coverage.

## Quick start

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
docker compose up -d postgres              # Postgres 17 + pgvector on localhost:5433

.venv/bin/python -m ingest init-db         # schema + migrations (idempotent)
.venv/bin/python -m ingest crawl --per-category 100
.venv/bin/python -m ingest embed           # needs requirements-embed.txt (torch)
.venv/bin/python -m ingest stats

.venv/bin/python -m bundle build --out dist --encoding int8
.venv/bin/python -m bundle verify  dist    # checksums + nearest-neighbour round trip

.venv/bin/python -m recsys seeds --n 24
.venv/bin/python -m recsys feed --seeds <id> <id> --manifest
.venv/bin/python -m reader shot <id> --device iphone14
.venv/bin/python -m eval.quantization_recall --source db
```

Every write is an upsert, so all commands are safe to re-run. `ingest embed --embedder hashing`
substitutes a deterministic offline stand-in so the pipeline can be exercised without a ~2 GB
torch install and a 440 MB model download.

## Bundle artifacts

| File | Contents |
|---|---|
| `app_bundle.db.zst` | SQLite: `papers`, `topics`, `paper_topics`, `meta`, plus an FTS5 index over title+abstract for **offline full-text search**. zstd at ~34% of raw. |
| `vectors.bin` | Mean-centered, quantized embeddings aligned to `papers.vec_index`. |
| `delta/<date>.jsonl.zst` | Papers newer than a cutoff, for incremental sync. |
| `manifest.json` | Versions, SHA-256 per file, corpus stats, and **the ranking configuration**. |

### `vectors.bin` format

Fixed layout across encodings — `scales` is always present (uniformly 1.0 for binary) — so a
client needs one parser. `read_vectors()` in [bundle/builder.py](bundle/builder.py) is the
reference implementation and doubles as the executable spec:

```
magic           4 bytes   "DPV1"
header_len      uint32<   length of the JSON header
header          JSON      encoding, count, dim, code_dtype, centered, layout
ids             int64<    [count]     maps row → papers.id
scales          float32<  [count]     per-vector scale (1.0 for binary)
codes           int8/uint8[count, dim]
centroid        float32<  [dim]       subtracted before quantization
```

Approximate cosine for int8 is `(codes @ query) * scales`, using an exact float32 query.
Because codes are centered, this yields centered cosine directly.

## Design notes

Two schema decisions are load-bearing:

- **`papers` models the work; `paper_versions` models the arXiv submission.** A preprint and
  its published version are one work with two versions. Without this split the feed shows the
  same paper twice and splits the engagement signal that trains the recommender.
- **`feed_impressions` is not optional.** Without logged impressions you cannot distinguish
  "the user ignored this" from "the user never saw it because we ranked it 90th". The same
  reasoning drives `events.client_event_id UNIQUE`: mobile clients batch and retry, so without
  an idempotency key you silently double-count engagement.

Gotchas discovered the hard way, each documented at its site in the code:

- **An HTTP `200` from `arxiv.org/html/{id}` is not evidence of full text.** arXiv serves a
  styled error page; detection needs the LaTeXML `ltx_page_content` marker.
- **`adapters` 1.3.0 logs "no adapters activated" on every forward** even when the adapter is
  active — verified by toggling `set_active_adapters` and diffing outputs. Do not "fix" it.
- **class matching for LaTeXML must be substring-based.** `class="ltx_para ltx_noindent"` is
  missed by an exact `class="ltx_para"` match, which silently reported 2 paragraphs for a
  125-paragraph paper.

## Being a good citizen

arXiv asks for ≤1 request every 3 seconds on its query API and discourages aggressive
crawling. The client enforces a per-host minimum interval across a small thread pool, sends
an identifying `User-Agent`, backs off exponentially on `429`/`5xx`, and caches every
response to disk, so re-runs do not re-hit the APIs.

Only open-access content is ingested and rehosted; paywalled papers are deep-linked, never
mirrored.

## Layout

```
dailypapers/            Core package (shared by ingest, bundle, recsys, eval, reader)
  http.py               Polite HTTP client: per-host limiting, retries, disk cache
  arxiv.py              arXiv API client: Atom parsing, identity, date-range queries
  openalex.py           OpenAlex enrichment via arXiv DOI
  coverage.py           HTML full-text detection (status + LaTeXML marker)
  embed.py              SPECTER2 embedder (+ offline hashing stand-in)
  quantize.py           int8 / binary quantization, Hamming, top-k
  db.py                 Connection, schema, migrations, idempotent upserts
  config.py             Env-driven settings (stdlib .env loader)
ingest/                 Pipeline: crawl | embed | init-db | migrate | stats
bundle/                 Static bundle builder, reference vector reader, verifier
recsys/                 On-device feed: candidates, scoring, MMR, exploration, eval
reader/                 Reader spike: extractor, reflowed CSS, WebDriver measurement
eval/                   Offline evaluation (quantization recall)
spike/                  Phase 0 coverage analysis (stdlib only)
db/schema.sql           Base schema
db/migrations/          Numbered, tracked in schema_migrations
docker-compose.yml      Postgres 17 + pgvector on host port 5433
```
