"""Ingestion pipeline: arXiv fetch -> HTML probe -> OpenAlex enrich -> Postgres.

Split deliberately into two phases:

  1. **Network phase (concurrent).** The polite client rate-limits *per host*, so arXiv and
     OpenAlex requests genuinely overlap. Threads help here.
  2. **Write phase (sequential).** A psycopg connection is not thread safe, and doing writes
     serially keeps transactions simple and failures easy to reason about.

Progress is committed in batches so a late failure does not discard an hour of crawling.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import psycopg

from dailypapers import arxiv, coverage, openalex
from dailypapers.db import save_paper
from dailypapers.http import PoliteClient

COMMIT_EVERY = 25


@dataclass
class IngestResult:
    fetched: int = 0
    html_probed: int = 0
    html_available: int = 0
    enriched: int = 0
    saved: int = 0
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            f"  fetched from arXiv : {self.fetched}",
            f"  HTML probed        : {self.html_probed}",
            f"  HTML available     : {self.html_available}"
            + (f" ({100.0 * self.html_available / self.html_probed:.1f}%)" if self.html_probed else ""),
            f"  OpenAlex matched   : {self.enriched}"
            + (f" ({100.0 * self.enriched / self.fetched:.1f}%)" if self.fetched else ""),
            f"  rows upserted      : {self.saved}",
        ]
        if self.errors:
            lines.append(f"  errors             : {len(self.errors)}")
            for err in self.errors[:5]:
                lines.append(f"    - {err}")
        return "\n".join(lines)


def _collect(
    client: PoliteClient,
    papers: list[dict],
    *,
    probe_html: bool,
    enrich: bool,
    workers: int,
) -> list[tuple[dict, bool | None, dict | None]]:
    """Phase 1: all network work, concurrently across hosts."""

    def work(paper: dict) -> tuple[dict, bool | None, dict | None]:
        html_available: bool | None = None
        if probe_html:
            html_available, _status = coverage.has_full_text_html(client, paper["arxiv_id"])
        enrichment = openalex.enrich(client, paper) if enrich else None
        return paper, html_available, enrichment

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(work, papers))


def crawl(
    conn: psycopg.Connection,
    client: PoliteClient,
    categories: list[str],
    *,
    per_category: int = 50,
    probe_html: bool = True,
    enrich: bool = True,
    workers: int = 4,
    limit: int | None = None,
    verbose: bool = True,
) -> IngestResult:
    result = IngestResult()

    if verbose:
        print(f"fetching up to {per_category}/category from {', '.join(categories)} ...", flush=True)
    papers = arxiv.fetch_recent(client, categories, per_category)
    if limit:
        papers = papers[:limit]
    result.fetched = len(papers)
    if verbose:
        print(f"  {len(papers)} unique papers", flush=True)

    if not papers:
        return result

    if verbose:
        print(f"collecting metadata ({workers} workers) ...", flush=True)
    collected = _collect(
        client, papers, probe_html=probe_html, enrich=enrich, workers=workers
    )

    if verbose:
        print("writing to Postgres ...", flush=True)
    for i, (paper, html_available, enrichment) in enumerate(collected, 1):
        if probe_html:
            result.html_probed += 1
            if html_available:
                result.html_available += 1
        if enrichment:
            result.enriched += 1
        try:
            save_paper(conn, paper, html_available=html_available, enrichment=enrichment)
            result.saved += 1
        except psycopg.Error as exc:
            # One bad row must not abort the crawl; roll back just that row.
            conn.rollback()
            result.errors.append(f"{paper.get('arxiv_id')}: {exc}")
            continue

        if i % COMMIT_EVERY == 0:
            conn.commit()
            if verbose:
                print(f"  committed {i}/{len(collected)}", flush=True)

    conn.commit()
    return result
