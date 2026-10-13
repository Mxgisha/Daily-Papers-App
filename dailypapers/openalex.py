"""OpenAlex enrichment.

arXiv preprints resolve through OpenAlex by DOI (``10.48550/arXiv.<id>``) rather than by
title search, which avoids fuzzy-match errors. Note that OpenAlex returns abstracts as an
inverted index for licensing reasons, so they must be reconstructed.
"""

from __future__ import annotations

import json

from .http import PoliteClient

API = "https://api.openalex.org/works/doi:{doi}"


def abstract_from_inverted_index(inverted: dict | None) -> str | None:
    """Rebuild plain text from OpenAlex's inverted abstract index."""
    if not inverted:
        return None
    positions: dict[int, str] = {}
    for word, idxs in inverted.items():
        for i in idxs:
            positions[i] = word
    if not positions:
        return None
    return " ".join(positions[i] for i in sorted(positions))


def enrich(client: PoliteClient, paper: dict) -> dict | None:
    """Return OpenAlex metadata for a paper, or None if it is not indexed."""
    resp = client.get(API.format(doi=paper["doi"]))
    if not resp.ok:
        return None
    try:
        w = json.loads(resp.body)
    except ValueError:
        return None

    location = w.get("primary_location") or {}
    source = location.get("source") or {}
    open_access = w.get("open_access") or {}
    best_oa = w.get("best_oa_location") or {}

    return {
        "openalex_id": (w.get("ids") or {}).get("openalex"),
        "doi": w.get("doi"),
        "title": w.get("title"),
        "type": w.get("type"),
        "publication_date": w.get("publication_date"),
        "cited_by_count": w.get("cited_by_count"),
        "referenced_works_count": w.get("referenced_works_count"),
        "venue": source.get("display_name"),
        "is_oa": open_access.get("is_oa"),
        "oa_status": open_access.get("oa_status"),
        "best_oa_pdf_url": best_oa.get("pdf_url"),
        # Kept as name+score rather than bare strings: topic confidence feeds the
        # recommender's content-based ranking.
        "topics": [
            {"name": t.get("display_name"), "score": t.get("score")}
            for t in (w.get("topics") or [])
            if t.get("display_name")
        ][:5],
        "concepts": [
            c.get("display_name")
            for c in (w.get("concepts") or [])
            if (c.get("score") or 0) > 0.3
        ][:8],
        "abstract": abstract_from_inverted_index(w.get("abstract_inverted_index")),
    }
