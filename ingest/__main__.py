"""CLI for the Daily Papers ingestion pipeline.

    python3 -m ingest init-db                  # schema + migrations (idempotent)
    python3 -m ingest crawl --per-category 50
    python3 -m ingest embed                    # SPECTER2 vectors for new papers
    python3 -m ingest embed --embedder hashing # offline stand-in, no model download
    python3 -m ingest stats
"""

from __future__ import annotations

import argparse
import sys

from dailypapers import db as dbmod
from dailypapers.config import load_settings
from dailypapers.embed import get_embedder
from dailypapers.http import PoliteClient

from .pipeline import crawl, embed_papers


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ingest", description="Daily Papers ingestion")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db", help="apply db/schema.sql then pending migrations")
    sub.add_parser("migrate", help="apply pending migrations only")
    sub.add_parser("stats", help="print row counts")

    c = sub.add_parser("crawl", help="fetch recent papers, enrich, and store them")
    c.add_argument("--per-category", type=int, default=50)
    c.add_argument("--categories", nargs="*", default=None,
                   help="override ARXIV_CATEGORIES, e.g. cs.LG cs.CL")
    c.add_argument("--limit", type=int, default=None, help="cap total papers (smoke runs)")
    c.add_argument("--workers", type=int, default=4)
    c.add_argument("--no-enrich", action="store_true", help="skip OpenAlex enrichment")
    c.add_argument("--no-html", action="store_true", help="skip the arXiv HTML probe")

    e = sub.add_parser("embed", help="compute embeddings for papers that lack them")
    e.add_argument("--embedder", default="specter2", choices=["specter2", "hashing"])
    e.add_argument("--limit", type=int, default=None)
    e.add_argument("--batch-size", type=int, default=16)
    e.add_argument("--all", action="store_true", help="re-embed rows that already have a vector")

    args = parser.parse_args(argv)
    settings = load_settings()

    if args.cmd == "init-db":
        with dbmod.connect(settings.database_url) as conn:
            dbmod.apply_schema(conn)
            applied = dbmod.apply_migrations(conn)
        print(f"schema applied; migrations applied: {applied or 'none pending'}")
        return 0

    if args.cmd == "migrate":
        with dbmod.connect(settings.database_url) as conn:
            applied = dbmod.apply_migrations(conn)
        print(f"migrations applied: {applied or 'none pending'}")
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

    if args.cmd == "embed":
        embedder = get_embedder(args.embedder)
        with dbmod.connect(settings.database_url) as conn:
            saved = embed_papers(
                conn,
                embedder,
                limit=args.limit,
                batch_size=args.batch_size,
                only_missing=not args.all,
            )
        print(f"embedded {saved} papers with {embedder.name}")
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
