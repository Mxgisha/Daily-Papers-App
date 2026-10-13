"""CLI for the Daily Papers ingestion pipeline.

    python3 -m ingest init-db
    python3 -m ingest crawl --per-category 50
    python3 -m ingest crawl --limit 20 --no-enrich
    python3 -m ingest stats
"""

from __future__ import annotations

import argparse
import sys

from dailypapers import db as dbmod
from dailypapers.config import load_settings
from dailypapers.http import PoliteClient

from .pipeline import crawl


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ingest", description="Daily Papers ingestion")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db", help="apply db/schema.sql (idempotent)")
    sub.add_parser("stats", help="print row counts")

    c = sub.add_parser("crawl", help="fetch recent papers, enrich, and store them")
    c.add_argument("--per-category", type=int, default=50)
    c.add_argument("--categories", nargs="*", default=None,
                   help="override ARXIV_CATEGORIES, e.g. cs.LG cs.CL")
    c.add_argument("--limit", type=int, default=None, help="cap total papers (smoke runs)")
    c.add_argument("--workers", type=int, default=4)
    c.add_argument("--no-enrich", action="store_true", help="skip OpenAlex enrichment")
    c.add_argument("--no-html", action="store_true", help="skip the arXiv HTML probe")

    args = parser.parse_args(argv)
    settings = load_settings()

    if args.cmd == "init-db":
        with dbmod.connect(settings.database_url) as conn:
            dbmod.apply_schema(conn)
        print("schema applied")
        return 0

    if args.cmd == "stats":
        with dbmod.connect(settings.database_url) as conn:
            for key, value in dbmod.stats(conn).items():
                print(f"  {key:20s} {value}")
        return 0

    if args.cmd == "crawl":
        client = PoliteClient(
            settings.cache_dir,
            min_interval=settings.http_min_interval,
            user_agent=settings.user_agent,
        )
        categories = args.categories or settings.categories
        with dbmod.connect(settings.database_url) as conn:
            result = crawl(
                conn,
                client,
                categories,
                per_category=args.per_category,
                probe_html=not args.no_html,
                enrich=not args.no_enrich,
                workers=args.workers,
                limit=args.limit,
            )
        print("ingest complete:")
        print(result.summary())
        print(f"  http stats         : {client.stats}")
        return 0 if not result.errors else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
