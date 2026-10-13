# Daily Papers App

A mobile-first research paper reader with a daily personalized feed, progress sync,
favorites/collections, and a recommendation system that learns the user.

See **[PLAN.md](PLAN.md)** for the full strategy, stack, data model, staged recommender
design, and packaging plan.

## Status

**Phase 0 complete.** The HTML-first reader decision is validated with measured data, and the
ingestion foundation is running end to end.

| Measurement | Result |
|---|---|
| HTML full text — recent papers (<7 days) | **322/336 = 95.8%** |
| HTML full text — submitted 2020 | 133/144 = 92.4% |
| HTML full text — submitted 2017 | 112/137 = 81.8% |
| OpenAlex enrichment — same-day preprints | **100/100 = 100%**, zero lag |
| arXiv categories sampled | `cs.LG, cs.CL, cs.CV, cs.AI` |

Two planning assumptions were wrong in a useful direction: arXiv HTML is backfilled far deeper
than the assumed "post-Dec-2023" window (82% as far back as 2017), and there are no soft-404s,
so coverage is cleanly measurable per paper. **PDF is therefore a ~4% fallback path, not a
co-equal workstream.** Full output in [reports/spike_report.md](reports/spike_report.md).

Ingestion is live: `papers`, `paper_versions`, `authors`, `topics` and their link tables are
populated from arXiv + OpenAlex in Postgres 17 with pgvector — see [db/schema.sql](db/schema.sql).

Embeddings (SPECTER2) are deliberately **not** wired up yet. `papers.embedding` is nullable and
filled by a separate batch step, so ingestion is never blocked on a GPU or a model download.

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
docker compose up -d postgres          # Postgres 17 + pgvector on localhost:5433

.venv/bin/python -m ingest init-db     # apply the schema (idempotent)
.venv/bin/python -m ingest crawl --per-category 50
.venv/bin/python -m ingest stats       # row counts
```

The pipeline is fully idempotent — every write is an upsert, so re-running a crawl updates
rows rather than duplicating them. That is the normal case (backfills, retrying failed
enrichment, a corrected parser), not an exception.

## Phase 0 spike

The spike in `spike/` answered the question that decides the reader architecture. It runs on
the **Python standard library only** — no dependency or wheel-version risk.

```bash
python3 -m spike.run_spike                    # 100/category + historical sample
python3 -m spike.run_spike --per-category 40  # faster smoke run
python3 -m spike.run_spike --no-enrich        # HTML coverage only
```

Outputs `reports/spike_report.md` (readable) and `reports/spike_raw.json` (full data).
Responses are cached under `data/cache/`, so re-runs are instant and do not re-hit the APIs.

### The methodological trap worth knowing

A `200` from `arxiv.org/html/{id}` is **not** sufficient evidence of full text — arXiv serves a
styled HTML error page for papers it has no HTML for, and the abs page is itself HTML. Coverage
detection therefore requires the LaTeXML `ltx_page_content` marker, which appears only in
genuinely rendered papers. A naive status-or-content check inflates the number. See
[dailypapers/coverage.py](dailypapers/coverage.py).

### Being a good citizen

arXiv asks for ≤1 request every 3 seconds on its query API, and discourages aggressive
crawling. The client enforces a per-host minimum interval (`--min-interval`, default 0.6s)
across a small thread pool, sends an identifying `User-Agent`, backs off exponentially on
`429`/`5xx`, and caches every response to disk.

## Data sources

| Source | Role | Notes |
|---|---|---|
| arXiv API | Daily delta firehose | `https://export.arxiv.org/api/query` — **must use https** (http returns 301) |
| arXiv HTML | Reflowed full text | `arxiv.org/html/{id}` — backfilled to at least 2017 |
| OpenAlex | Enrichment (citations, venue, topics) | Resolves arXiv via DOI `10.48550/arXiv.{id}`; zero lag on preprints |
| Semantic Scholar | Recommendations + TLDR | Anonymous access is rate-limited (`429`); needs backoff or an API key |
| Unpaywall | Legal OA PDF fallback | Not needed for arXiv papers — arXiv always serves its own PDF |

## Layout

```
dailypapers/          Core package (shared by spike + ingest)
  http.py             Polite HTTP client: per-host rate limiting, retries, disk cache
  arxiv.py            arXiv API client: paged Atom fetch, identity, date-range queries
  openalex.py         OpenAlex enrichment via arXiv DOI
  coverage.py         HTML full-text detection (status + LaTeXML marker)
  config.py           Env-driven settings (.env loader, stdlib only)
  db.py               Connection, schema application, idempotent upserts
ingest/               Production pipeline
  pipeline.py         fetch -> probe -> enrich -> upsert, two-phase (concurrent net, serial DB)
  __main__.py         CLI: init-db | crawl | stats
spike/                Phase 0 analysis (stdlib only)
  run_spike.py        Orchestrator: fetch -> measure -> enrich -> report
db/schema.sql         Postgres schema (papers, versions, events, feed_impressions, ...)
docker-compose.yml    Postgres 17 + pgvector on host port 5433
```

## Design notes

Two schema decisions are load-bearing and worth not undoing later:

- **`papers` models the work; `paper_versions` models the arXiv submission.** A preprint and its
  published version are one work with two versions. Without this split the feed shows the same
  paper twice and splits the engagement signal that trains the recommender.
- **`feed_impressions` is not optional.** Without logged impressions you cannot distinguish
  "the user ignored this" from "the user never saw it because we ranked it 90th". Every offline
  evaluation of the recommender depends on it, and it cannot be backfilled.
