"""Export the static paper list the app ships with.

Deliberately not a bundle. The app needs a list of papers and nothing else -- no vectors, no
embeddings, no SQLite, no manifest. This is JSON that the app imports directly, and it keeps
the whole reader path free of the encoding and recommendation machinery.

Size is managed by shipping only the first sentences of each abstract. Nothing in the app
shows more than two lines, so the rest of a ~1,480-character abstract is paid for and never
read. The full text comes from arXiv when something actually needs it
(`fetchArxivById` in src/arxiv.ts).

Usage:
    python3 scripts/export_papers.py --out assets/papers.json --limit 1000
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from dailypapers.config import load_settings  # noqa: E402
from dailypapers.db import connect  # noqa: E402

SQL = """
SELECT p.arxiv_base_id       AS arxiv_id,
       p.title,
       p.abstract,
       p.primary_category,
       p.published_at,
       p.html_available,
       (SELECT json_agg(a.name ORDER BY pa.position)
          FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
         WHERE pa.paper_id = p.id) AS authors
  FROM papers p
 WHERE p.arxiv_base_id IS NOT NULL
 ORDER BY p.html_available DESC, p.published_at DESC
 LIMIT %(limit)s
"""


def first_sentences(text: str, max_chars: int) -> str:
    """Trim an abstract to the first sentences that fit a budget.

    The cut goes at the last sentence end inside the budget, because a sentence that stops
    mid-clause reads like a bug. If there is no sentence end far enough in, it falls back to a
    word boundary and marks the truncation with an ellipsis.
    """
    clean = " ".join(text.split())
    if len(clean) <= max_chars:
        return clean

    window = clean[:max_chars]
    cut = max(window.rfind(". "), window.rfind("? "), window.rfind("! "))
    # Ignore a sentence end so early that the result would be a fragment.
    if cut > max_chars // 3:
        return window[: cut + 1]

    space = window.rfind(" ")
    return (window[:space] if space > 0 else window).rstrip() + " …"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "mobile" / "assets" / "papers.json"))
    ap.add_argument("--limit", type=int, default=1000)
    ap.add_argument(
        "--abstract-chars",
        type=int,
        default=320,
        help="Abstract characters to ship per paper.",
    )
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with connect(load_settings().database_url) as conn:
        rows = conn.execute(SQL, {"limit": args.limit}).fetchall()

    papers = [
        {
            "id": r["arxiv_id"],
            "title": r["title"],
            "abstract": first_sentences(r["abstract"] or "", args.abstract_chars),
            "category": r["primary_category"] or "",
            "published": r["published_at"].date().isoformat() if r["published_at"] else None,
            "authors": (r["authors"] or [])[:8],
        }
        for r in rows
    ]

    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(papers),
        "abstractChars": args.abstract_chars,
        "papers": papers,
    }
    out.write_text(json.dumps(payload, separators=(",", ":")))

    size = out.stat().st_size
    renderable = sum(1 for r in rows if r["html_available"])
    print(f"wrote {out} ({size / 1024:.0f} KB)")
    print(f"  {len(papers)} papers, {renderable} with HTML ({100 * renderable / max(len(papers), 1):.0f}%)")
    print(f"  abstracts trimmed to {args.abstract_chars} chars ({size / max(len(papers), 1):.0f} B/paper)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
