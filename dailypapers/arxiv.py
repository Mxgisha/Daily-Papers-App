"""arXiv API client: paged Atom fetching and stable identity extraction."""

from __future__ import annotations

import re
import urllib.parse
import xml.etree.ElementTree as ET

from .http import PoliteClient

API = "https://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

# arXiv assigns DOIs of the form 10.48550/arXiv.<id>. This is what makes OpenAlex lookup
# possible without the fuzzy title matching that the naive approach would require.
ARXIV_DOI_PREFIX = "10.48550/arXiv."

_VERSION_RE = re.compile(r"v\d+$")


def arxiv_doi(arxiv_id: str) -> str:
    """The DOI arXiv mints for a paper, version stripped (versions share one DOI)."""
    return ARXIV_DOI_PREFIX + _VERSION_RE.sub("", arxiv_id)


def base_id(arxiv_id: str) -> str:
    """arXiv id without the version suffix."""
    return _VERSION_RE.sub("", arxiv_id)


def _text(entry: ET.Element, tag: str) -> str:
    el = entry.find(f"a:{tag}", NS)
    return " ".join(el.text.split()) if el is not None and el.text else ""


def parse_entries(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out: list[dict] = []
    for e in root.findall("a:entry", NS):
        raw_id = _text(e, "id")
        arxiv_id = raw_id.rsplit("/abs/", 1)[-1] if "/abs/" in raw_id else raw_id
        if not arxiv_id:
            continue
        links = {link.get("title") or link.get("rel"): link.get("href") for link in e.findall("a:link", NS)}
        primary = e.find("arxiv:primary_category", NS)
        out.append(
            {
                "arxiv_id": arxiv_id,
                "base_id": base_id(arxiv_id),
                "title": _text(e, "title"),
                "abstract": _text(e, "summary"),
                "authors": [_text(a, "name") for a in e.findall("a:author", NS)],
                "categories": [c.get("term") for c in e.findall("a:category", NS)],
                "primary_category": primary.get("term") if primary is not None else None,
                "published": _text(e, "published"),
                "updated": _text(e, "updated"),
                "abs_url": f"https://arxiv.org/abs/{arxiv_id}",
                "pdf_url": links.get("pdf") or f"https://arxiv.org/pdf/{arxiv_id}",
                "doi": arxiv_doi(arxiv_id),
            }
        )
    return out


def fetch_date_range(
    client: PoliteClient,
    category: str,
    start: str,
    end: str,
    limit: int = 60,
) -> list[dict]:
    """Papers submitted within a window, e.g. start="202001010000", end="202001312359".

    Used to measure HTML backfill coverage for older papers, which determines whether
    onboarding can let users seed their profile from a historical corpus or only from
    recent papers.
    """
    params = {
        "search_query": f"cat:{category} AND submittedDate:[{start} TO {end}]",
        "start": 0,
        "max_results": limit,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    resp = client.get(f"{API}?{urllib.parse.urlencode(params)}")
    if not resp.ok:
        return []
    return parse_entries(resp.body)


def fetch_recent(
    client: PoliteClient,
    categories: list[str],
    per_category: int = 100,
    page_size: int = 100,
) -> list[dict]:
    """Most recently submitted papers per category, deduplicated across categories.

    Deduplication matters: cross-listed papers appear in several category queries, and a
    feed that shows the same paper twice destroys trust in the recommender.
    """
    seen: set[str] = set()
    papers: list[dict] = []

    for cat in categories:
        fetched = 0
        start = 0
        while fetched < per_category:
            params = {
                "search_query": f"cat:{cat}",
                "start": start,
                "max_results": min(page_size, per_category - fetched),
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }
            resp = client.get(f"{API}?{urllib.parse.urlencode(params)}")
            if not resp.ok:
                print(f"    ! {cat}: API returned {resp.status}, stopping this category")
                break
            batch = parse_entries(resp.body)
            if not batch:
                break
            for p in batch:
                if p["arxiv_id"] not in seen:
                    seen.add(p["arxiv_id"])
                    papers.append(p)
            fetched += len(batch)
            start += len(batch)

    return papers
