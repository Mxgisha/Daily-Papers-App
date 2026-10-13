"""CLI for the on-device feed prototype.

    python3 -m recsys feed --seeds 2610.13935 2610.13931 2610.13928
    python3 -m recsys feed --seeds-file seeds.txt --source bundle --size 20
    python3 -m recsys seeds --n 24                 # onboarding seed suggestions
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

from .feed import Corpus, FeedConfig, evaluate_feed, generate_feed


def _load(args) -> Corpus:
    if args.source == "bundle":
        if not Path(args.bundle).exists():
            raise SystemExit(f"no bundle at {args.bundle}; run `python3 -m bundle build --out {args.bundle}`")
        return Corpus.from_bundle(Path(args.bundle))
    from dailypapers.config import load_settings
    from dailypapers.db import connect

    with connect(load_settings().database_url) as conn:
        return Corpus.from_db(conn)


def _resolve_seeds(corpus: Corpus, tokens: list[str]) -> tuple[list[int], list[str]]:
    by_arxiv = {p.arxiv_id: p.id for p in corpus.papers if p.arxiv_id}
    ids, missing = [], []
    for token in tokens:
        pid = by_arxiv.get(token) or by_arxiv.get(token.split("v")[0])
        if pid is None:
            missing.append(token)
        else:
            ids.append(pid)
    return ids, missing


def cmd_feed(args) -> int:
    corpus = _load(args)
    config = (
        FeedConfig.from_manifest(Path(args.bundle) / "manifest.json")
        if args.manifest
        else FeedConfig.from_dict({})
    )
    if args.size:
        config.feed_size = args.size
    if args.no_explore:
        config.exploration_epsilon = 0.0
    if args.mmr_lambda is not None:
        config.mmr_lambda = args.mmr_lambda

    tokens = list(args.seeds or [])
    if args.seeds_file:
        tokens += [
            line.strip()
            for line in Path(args.seeds_file).read_text().splitlines()
            if line.strip() and not line.startswith("#")
        ]
    if not tokens:
        raise SystemExit("no seeds given; pass --seeds or --seeds-file")

    seed_ids, missing = _resolve_seeds(corpus, tokens)
    if missing:
        print(f"warning: {len(missing)} seed(s) not in corpus: {', '.join(missing[:5])}", file=sys.stderr)
    if not seed_ids:
        raise SystemExit("no seeds resolved against the corpus")

    exclude = set()
    if args.exclude:
        exclude, _ = _resolve_seeds(corpus, args.exclude)

    feed, stats = generate_feed(
        corpus,
        seed_ids,
        config,
        exclude=exclude,
        now=datetime.now(timezone.utc),
        rng=random.Random(args.seed),
    )
    quality = evaluate_feed(corpus, feed)

    if args.json:
        print(json.dumps({
            "stats": stats,
            "quality": quality,
            "feed": [
                {
                    "rank": i,
                    "arxiv_id": s.paper.arxiv_id,
                    "title": s.paper.title,
                    "category": s.paper.primary_category,
                    "stage": s.stage,
                    "score": round(s.score, 4),
                    **{k: round(v, 4) for k, v in s.components.items()},
                }
                for i, s in enumerate(feed, 1)
            ],
        }, indent=2))
        return 0

    now = datetime.now(timezone.utc)
    print(f"source      : {args.source}")
    print(f"seeds used  : {len(stats['used_seeds'])} of {len(seed_ids)} resolved")
    print(f"candidates  : {stats['candidates']} -> pool {stats['pool']} "
          f"| ranked {stats['ranked_slots']} + exploration {stats['explore_slots']}")
    print(f"config      : lambda={config.mmr_lambda} eps={config.exploration_epsilon} "
          f"weights={config.weights}")
    print()
    print(f"{'#':>3}  {'cat':<9}{'age':>6} {'score':>7} {'sim':>6} {'rec':>5} {'topic':>6} "
          f"{'stage':<12} title")
    for i, s in enumerate(feed, 1):
        p = s.paper
        age = f"{(now - p.published_at).total_seconds() / 86400:.1f}d" if p.published_at else "?"
        c = s.components
        print(
            f"{i:>3}  {p.primary_category[:8]:<9}{age:>6} {s.score:>7.3f} "
            f"{c['similarity']:>6.3f} {c['recency']:>5.2f} {c['topic_overlap']:>6.2f} "
            f"{s.stage:<12} {p.title[:56]}"
        )

    print("\n--- feed quality ---")
    for key in (
        "distinct_categories", "topic_entropy_norm", "mean_pairwise_similarity",
        "mean_age_days", "pct_html", "exploration_items",
    ):
        print(f"  {key:26s} {quality.get(key)}")
    print(f"  {'category_spread':26s} {quality.get('category_spread')}")
    return 0


def cmd_seeds(args) -> int:
    """Suggest onboarding seeds: recent, renderable, spread across categories."""
    corpus = _load(args)
    now = datetime.now(timezone.utc)
    by_cat: dict[str, list] = {}
    for p in corpus.papers:
        if not p.html_available or p.vec_index is None or not p.published_at:
            continue
        by_cat.setdefault(p.primary_category, []).append(p)

    picked = []
    cats = sorted(by_cat, key=lambda c: -len(by_cat[c]))
    i = 0
    while len(picked) < args.n and cats:
        cat = cats[i % len(cats)]
        bucket = by_cat[cat]
        if bucket:
            picked.append(bucket.pop(0))
        cats = [c for c in cats if by_cat[c]]
        i += 1

    for p in picked:
        age = (now - p.published_at).total_seconds() / 86400
        print(f"{p.arxiv_id:<16} {p.primary_category:<9} {age:>4.1f}d  {p.title[:74]}")
    print(f"\n{len(picked)} seeds across {len({p.primary_category for p in picked})} categories")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="recsys", description="On-device feed prototype")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--source", choices=["bundle", "db"], default="bundle")
        sp.add_argument("--bundle", default="dist")

    f = sub.add_parser("feed", help="generate a feed from seed papers")
    common(f)
    f.add_argument("--seeds", nargs="*", default=[])
    f.add_argument("--seeds-file")
    f.add_argument("--exclude", nargs="*", default=[], help="papers to treat as already read")
    f.add_argument("--size", type=int, default=None)
    f.add_argument("--mmr-lambda", type=float, default=None)
    f.add_argument("--no-explore", action="store_true")
    f.add_argument("--seed", type=int, default=0, help="RNG seed for exploration")
    f.add_argument("--manifest", action="store_true",
                   help="use ranking weights from the bundle manifest")
    f.add_argument("--json", action="store_true")

    s = sub.add_parser("seeds", help="suggest onboarding seed papers")
    common(s)
    s.add_argument("--n", type=int, default=24)

    args = ap.parse_args(argv)
    if args.cmd == "feed":
        return cmd_feed(args)
    if args.cmd == "seeds":
        return cmd_seeds(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
