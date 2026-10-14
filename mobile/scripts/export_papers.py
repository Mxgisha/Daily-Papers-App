"""Export a small static paper list for the reader MVP.

Deliberately not a bundle. The reader MVP needs a list of papers and nothing else -- no
vectors, no embeddings, no SQLite, no manifest. This is a few hundred KB of JSON that the
app can load with a single fetch, and it keeps the whole reader path free of the encoding
and recommendation machinery.

Usage:
    python3 scripts/export_papers.py --out assets/papers.json --limit 300
"""

from __future__ import annotations

import argparse
import json
import sys
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
       p.pdf_url,
       p.citation_count,
       (SELECT json_agg(a.name ORDER BY pa.position)
          FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
         WHERE pa.paper_id = p.id) AS authors
  FROM papers p
 WHERE p.arxiv_base_id IS NOT NULL
 ORDER BY p.html_available DESC, p.published_at DESC
 LIMIT %(limit)s
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "mobile" / "assets" / "papers.json"))
    ap.add_argument("--limit", type=int, default=300)
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with connect(load_settings().database_url) as conn:
        rows = conn.execute(SQL, {"limit": args.limit}).fetchall()

    papers = [
        {
            "id": r["arxiv_id"],
            "title": r["title"],
            "abstract": r["abstract"] or "",
            "category": r["primary_category"] or "",
            "published": r["published_at"].date().isoformat() if r["published_at"] else None,
            "html": bool(r["html_available"]),
            "pdf": r["pdf_url"],
            "citations": r["citation_count"] or 0,
            "authors": (r["authors"] or [])[:8],
        }
        for r in rows
    ]

    payload = {
        "generated": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(
            timespec="seconds"
        ),
        "count": len(papers),
        "papers": papers,
    }
    out.write_text(json.dumps(payload, separators=(",", ":")))

    size = out.stat().st_size
    renderable = sum(1 for p in papers if p["html"])
    print(f"wrote {out} ({size / 1024:.0f} KB)")
    print(f"  {len(papers)} papers, {renderable} with HTML ({100 * renderable / max(len(papers), 1):.0f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
