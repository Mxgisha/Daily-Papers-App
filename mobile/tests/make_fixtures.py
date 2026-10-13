"""Export fixtures from the real bundle so the TypeScript port can be checked against the
Python reference implementation.

This is the point of the whole exercise: the Python `recsys` package is the definition of
correct, and the TypeScript client must reproduce it exactly on real data. A fixture that
is generated from the shipped artifacts means any drift -- a row-offset mix-up, a rounding
difference, a different MMR tie-break -- shows up as a failing test rather than as subtly
wrong recommendations on a user's phone.

Usage:
    python3 tests/make_fixtures.py --bundle ../dist --out fixtures
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from recsys.feed import Corpus, FeedConfig, evaluate_feed, generate_feed  # noqa: E402

# Fixed clock so both implementations see identical recency values.
FIXED_NOW = datetime(2026, 10, 13, 12, 0, 0, tzinfo=timezone.utc)

# Seeds chosen to span four categories, so a wrong vector mapping shows up as a feed that
# collapses onto one category.
SEEDS = ["2610.13935", "2610.13928", "2610.13912", "2610.13840", "2610.13740"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=str(ROOT / "dist"))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "fixtures"))
    args = ap.parse_args()

    bundle = Path(args.bundle)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    corpus = Corpus.from_bundle(bundle)

    # --- corpus.json: exactly the fields the TS Paper type needs -----------
    papers = [
        {
            "id": p.id,
            "arxivId": p.arxiv_id,
            "title": p.title,
            "abstract": p.abstract,
            "primaryCategory": p.primary_category,
            "categories": p.categories,
            "topics": p.topics,
            "publishedAt": int(p.published_at.timestamp() * 1000) if p.published_at else None,
            "htmlAvailable": p.html_available,
            "citationCount": p.citation_count,
            "vecIndex": p.vec_index,
        }
        for p in corpus.papers
    ]
    (out / "corpus.json").write_text(json.dumps(papers))

    by_arxiv = {p.arxiv_id: p.id for p in corpus.papers}
    seed_ids = [by_arxiv[s] for s in SEEDS if s in by_arxiv]
    missing = [s for s in SEEDS if s not in by_arxiv]
    if missing:
        print(f"warning: seeds not in corpus: {missing}", file=sys.stderr)

    # Exploration off: Python's random.sample and the JS PRNG are different streams, and
    # comparing them would test the RNG rather than the ranking.
    config = FeedConfig.from_dict({"exploration_epsilon": 0.0})

    feed, stats = generate_feed(corpus, seed_ids, config, now=FIXED_NOW)
    quality = evaluate_feed(corpus, feed, now=FIXED_NOW)

    expected = {
        "config": {
            "weights": config.weights,
            "mmrLambda": config.mmr_lambda,
            "explorationEpsilon": config.exploration_epsilon,
            "htmlBonus": config.html_bonus,
            "recencyHalflifeDays": config.recency_halflife_days,
            "feedSize": config.feed_size,
            "candidatePool": config.candidate_pool,
        },
        "nowMs": int(FIXED_NOW.timestamp() * 1000),
        "seedArxivIds": SEEDS,
        "seedIds": seed_ids,
        "stats": stats,
        "quality": quality,
        "feed": [
            {
                "rank": i,
                "arxivId": s.paper.arxiv_id,
                "score": round(s.score, 6),
                "components": {k: round(v, 6) for k, v in s.components.items()},
                "stage": s.stage,
            }
            for i, s in enumerate(feed, 1)
        ],
    }
    (out / "expected_feed.json").write_text(json.dumps(expected, indent=2))

    print(f"wrote {out / 'corpus.json'}          ({len(papers)} papers)")
    print(f"wrote {out / 'expected_feed.json'}   ({len(feed)} items, {stats['candidates']} candidates)")
    print(f"  quality: pairwise={quality['mean_pairwise_similarity']} "
          f"cats={quality['distinct_categories']} entropy={quality['topic_entropy_norm']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
