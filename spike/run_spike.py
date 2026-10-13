"""Phase 0 spike: measure arXiv HTML full-text coverage and OpenAlex enrichment quality.

Answers, with real numbers, the questions that decide the reader architecture:

  1. What share of papers have genuinely rendered HTML full text?
  2. Does OpenAlex enrich same-day preprints, or does it lag behind?
  3. Does HTML availability hold for older papers (backfill / cold-start seeding)?

Usage:
    python3 -m spike.run_spike
    python3 -m spike.run_spike --per-category 40 --no-enrich
    python3 -m spike.run_spike --historical-years 2020 2017
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from dailypapers import arxiv, coverage, openalex
from dailypapers.http import PoliteClient

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
REPORTS = ROOT / "reports"

DEFAULT_CATEGORIES = ["cs.LG", "cs.CL", "cs.CV", "cs.AI"]


def pct(num: int, den: int) -> str:
    return f"{100.0 * num / den:.1f}%" if den else "n/a"


def parse_dt(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def age_days(published: str) -> float | None:
    dt = parse_dt(published)
    if dt is None:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0


def check_html(client: PoliteClient, papers: list[dict], workers: int, label: str) -> list[dict]:
    """Annotate each paper with HTML full-text availability, concurrently but politely."""

    def check(p: dict) -> dict:
        ok, status = coverage.has_full_text_html(client, p["arxiv_id"])
        return {**p, "html_full_text": ok, "html_status": status}

    print(f"  checking {len(papers)} papers for HTML full text ({workers} workers) ...", flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(check, papers))

    found = sum(r["html_full_text"] for r in results)
    print(f"  {label}: {found}/{len(results)} have rendered HTML ({pct(found, len(results))})", flush=True)
    return results


def age_bucket(days: float | None) -> str:
    if days is None:
        return "unknown"
    if days < 7:
        return "<7 days"
    if days < 30:
        return "7-30 days"
    if days < 365:
        return "30-365 days"
    return ">1 year"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--categories", nargs="*", default=DEFAULT_CATEGORIES)
    ap.add_argument("--per-category", type=int, default=100)
    ap.add_argument("--historical-years", nargs="*", type=int, default=[2020, 2017])
    ap.add_argument("--historical-per-year", type=int, default=40)
    ap.add_argument("--enrich-limit", type=int, default=100)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--min-interval", type=float, default=0.6)
    ap.add_argument("--no-enrich", action="store_true")
    ap.add_argument("--no-historical", action="store_true")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    REPORTS.mkdir(exist_ok=True)
    client = PoliteClient(DATA / "cache", min_interval=args.min_interval)

    # ---- 1. Recent papers -------------------------------------------------------------
    print(f"[1/4] fetching recent papers from {', '.join(args.categories)} ...", flush=True)
    recent = arxiv.fetch_recent(client, args.categories, args.per_category)
    print(f"  got {len(recent)} unique recent papers", flush=True)
    if not recent:
        print("FATAL: no papers fetched; arXiv API may be unreachable.", flush=True)
        return 1
    recent = check_html(client, recent, args.workers, "recent")

    # ---- 2. Historical sample (backfill coverage) -------------------------------------
    historical: list[dict] = []
    if not args.no_historical:
        print(f"[2/4] sampling historical papers ({args.historical_years}) ...", flush=True)
        for year in args.historical_years:
            batch: list[dict] = []
            for cat in args.categories:
                batch += arxiv.fetch_date_range(
                    client, cat, f"{year}01010000", f"{year}01312359", args.historical_per_year
                )
            seen: set[str] = set()
            batch = [p for p in batch if not (p["arxiv_id"] in seen or seen.add(p["arxiv_id"]))]
            if batch:
                historical += check_html(client, batch, args.workers, f"submitted {year}")
    else:
        print("[2/4] skipping historical sample", flush=True)

    # ---- 3. OpenAlex enrichment -------------------------------------------------------
    enriched: list[dict] = []
    if not args.no_enrich:
        sample = recent[: args.enrich_limit]
        print(f"[3/4] enriching {len(sample)} recent papers via OpenAlex ...", flush=True)
        for i, p in enumerate(sample, 1):
            if i % 25 == 0:
                print(f"  ... {i}/{len(sample)}", flush=True)
            enriched.append({**p, "openalex": openalex.enrich(client, p)})
    else:
        print("[3/4] skipping OpenAlex enrichment", flush=True)

    # ---- 4. Report --------------------------------------------------------------------
    print("[4/4] writing report ...", flush=True)
    report = build_report(args, recent, historical, enriched, client)
    (REPORTS / "spike_report.md").write_text(report)
    (REPORTS / "spike_raw.json").write_text(
        json.dumps(
            {
                "recent": recent,
                "historical": historical,
                "enriched": enriched,
                "client_stats": client.stats,
            },
            indent=2,
        )
    )
    print(report, flush=True)
    print(f"  wrote {REPORTS / 'spike_report.md'}", flush=True)
    return 0


def build_report(
    args: argparse.Namespace,
    recent: list[dict],
    historical: list[dict],
    enriched: list[dict],
    client: PoliteClient,
) -> str:
    L: list[str] = []
    total = len(recent)
    html_ok = sum(p["html_full_text"] for p in recent)

    L.append("# Phase 0 Spike Report — arXiv HTML Coverage & Enrichment\n")
    L.append(f"Generated: {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n")
    L.append(
        f"Categories: `{', '.join(args.categories)}` · recent sample: {total} papers "
        f"({args.per_category}/category) · historical sample: {len(historical)} papers\n"
    )

    # Headline
    L.append("## Headline\n")
    L.append(f"- **HTML full text available: {html_ok}/{total} = {pct(html_ok, total)}** of recent papers")
    if enriched:
        hit = sum(1 for p in enriched if p["openalex"])
        L.append(f"- **OpenAlex enrichment: {hit}/{len(enriched)} = {pct(hit, len(enriched))}** of recent papers")
    if historical:
        h_ok = sum(p["html_full_text"] for p in historical)
        L.append(f"- **Historical backfill: {h_ok}/{len(historical)} = {pct(h_ok, len(historical))}** of sampled older papers")
    L.append("")

    # Status codes
    L.append("## HTTP status distribution (HTML endpoint)\n")
    L.append("| Status | Count | Share |")
    L.append("|---|---|---|")
    for status, count in Counter(p["html_status"] for p in recent).most_common():
        L.append(f"| {status} | {count} | {pct(count, total)} |")
    L.append("")

    # By category
    L.append("## HTML coverage by primary category\n")
    L.append("| Category | Papers | With HTML | Coverage |")
    L.append("|---|---|---|---|")
    by_cat: dict[str, list[dict]] = {}
    for p in recent:
        by_cat.setdefault(p.get("primary_category") or "unknown", []).append(p)
    for cat, ps in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
        ok = sum(p["html_full_text"] for p in ps)
        L.append(f"| `{cat}` | {len(ps)} | {ok} | {pct(ok, len(ps))} |")
    L.append("")

    # By age
    L.append("## HTML coverage by paper age\n")
    L.append("| Age bucket | Papers | With HTML | Coverage |")
    L.append("|---|---|---|---|")
    buckets: dict[str, list[dict]] = {}
    for p in recent:
        buckets.setdefault(age_bucket(age_days(p["published"])), []).append(p)
    order = ["<7 days", "7-30 days", "30-365 days", ">1 year", "unknown"]
    for name in order:
        ps = buckets.get(name)
        if not ps:
            continue
        ok = sum(p["html_full_text"] for p in ps)
        L.append(f"| {name} | {len(ps)} | {ok} | {pct(ok, len(ps))} |")
    L.append("")

    # Enrichment detail
    if enriched:
        hit = [p for p in enriched if p["openalex"]]
        L.append("## OpenAlex enrichment detail\n")
        L.append(f"Matched {len(hit)}/{len(enriched)} papers by arXiv DOI (`10.48550/arXiv.<id>`).\n")
        if hit:
            def share(pred) -> str:
                return pct(sum(1 for p in hit if pred(p["openalex"])), len(hit))

            L.append("| Field populated | Share of matched |")
            L.append("|---|---|")
            L.append(f"| Venue | {share(lambda o: bool(o['venue']))} |")
            L.append(f"| Topics | {share(lambda o: bool(o['topics']))} |")
            L.append(f"| Concepts | {share(lambda o: bool(o['concepts']))} |")
            L.append(f"| Abstract | {share(lambda o: bool(o['abstract']))} |")
            L.append(f"| OA status | {share(lambda o: bool(o['oa_status']))} |")
            L.append(f"| OA PDF URL | {share(lambda o: bool(o['best_oa_pdf_url']))} |")
            L.append(f"| Cited by > 0 | {share(lambda o: (o['cited_by_count'] or 0) > 0)} |")
            L.append("")
            L.append("### Sample enriched records\n")
            for p in hit[:5]:
                o = p["openalex"]
                L.append(f"- **{p['title'][:80]}**")
                L.append(
                    f"  - venue: `{o['venue']}` · type: `{o['type']}` · cited_by: {o['cited_by_count']}"
                    f" · oa: `{o['oa_status']}`"
                )
                L.append(f"  - topics: {', '.join(t['name'] for t in o['topics']) or 'none'}")
            L.append("")
        misses = [p for p in enriched if not p["openalex"]]
        if misses:
            L.append(f"### Unmatched ({len(misses)})\n")
            L.append("DOI lookup failed for these — candidates for title-search fallback:\n")
            for p in misses[:10]:
                L.append(f"- `{p['doi']}` — {p['title'][:70]}")
            L.append("")

    # Historical detail
    if historical:
        L.append("## Historical backfill detail\n")
        L.append("| Submitted | Papers | With HTML | Coverage |")
        L.append("|---|---|---|---|")
        by_year: dict[str, list[dict]] = {}
        for p in historical:
            dt = parse_dt(p["published"])
            by_year.setdefault(str(dt.year) if dt else "unknown", []).append(p)
        for year, ps in sorted(by_year.items()):
            ok = sum(p["html_full_text"] for p in ps)
            L.append(f"| {year} | {len(ps)} | {ok} | {pct(ok, len(ps))} |")
        L.append("")

    # Decision
    L.append("## Decision\n")
    if total:
        rate = 100.0 * html_ok / total
        if rate >= 70:
            L.append(
                f"**HTML-first reader confirmed.** {rate:.1f}% coverage means the majority of the "
                "feed reads as reflowed native text. Build the HTML reader as the primary path and "
                "treat PDF as a fallback for the minority."
            )
        elif rate >= 40:
            L.append(
                f"**Hybrid reader required.** At {rate:.1f}% coverage neither path dominates, so both "
                "the HTML reader and a performant native PDF reader are first-class from day one — "
                "more scope, so plan the reader as the largest single workstream."
            )
        else:
            L.append(
                f"**PDF-first reader.** Only {rate:.1f}% have HTML, so PDF rendering quality and "
                "resume-position accuracy become the critical path. Reconsider whether a WebView-based "
                "client (Capacitor) can meet the bar, or scope to categories with better coverage."
            )
    L.append("")
    L.append("---\n")
    L.append(f"Client stats: `{json.dumps(client.stats)}`")
    L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    raise SystemExit(main())
