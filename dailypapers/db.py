"""Postgres access: connection helper, schema application, and idempotent upserts.

Every write is an upsert so the pipeline can be re-run safely. Re-running ingestion is the
normal case (backfills, failed enrichment retries, a corrected parser), not an exception.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "db" / "schema.sql"


def connect(database_url: str) -> psycopg.Connection:
    return psycopg.connect(database_url, row_factory=dict_row)


def apply_schema(conn: psycopg.Connection, path: Path = SCHEMA_PATH) -> None:
    with conn.cursor() as cur:
        cur.execute(path.read_text())
    conn.commit()


def _dt(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp (arXiv uses a trailing Z)."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Statements
# --------------------------------------------------------------------------

UPSERT_PAPER = """
INSERT INTO papers (
    doi, arxiv_base_id, title, abstract, venue, primary_category, categories,
    published_at, arxiv_updated_at, html_available, html_url, pdf_url,
    oa_status, citation_count, reference_count, openalex_id, enriched_at, row_updated_at
) VALUES (
    %(doi)s, %(arxiv_base_id)s, %(title)s, %(abstract)s, %(venue)s, %(primary_category)s, %(categories)s,
    %(published_at)s, %(arxiv_updated_at)s, %(html_available)s, %(html_url)s, %(pdf_url)s,
    %(oa_status)s, %(citation_count)s, %(reference_count)s, %(openalex_id)s, %(enriched_at)s, now()
)
ON CONFLICT (arxiv_base_id) DO UPDATE SET
    doi             = COALESCE(EXCLUDED.doi, papers.doi),
    title           = EXCLUDED.title,
    abstract        = COALESCE(EXCLUDED.abstract, papers.abstract),
    venue           = COALESCE(EXCLUDED.venue, papers.venue),
    primary_category = EXCLUDED.primary_category,
    categories      = EXCLUDED.categories,
    published_at    = COALESCE(EXCLUDED.published_at, papers.published_at),
    arxiv_updated_at = COALESCE(EXCLUDED.arxiv_updated_at, papers.arxiv_updated_at),
    html_available  = COALESCE(EXCLUDED.html_available, papers.html_available),
    html_url        = COALESCE(EXCLUDED.html_url, papers.html_url),
    pdf_url         = COALESCE(EXCLUDED.pdf_url, papers.pdf_url),
    oa_status       = COALESCE(EXCLUDED.oa_status, papers.oa_status),
    -- Citations only ever grow; never let a stale crawl lower them.
    citation_count  = GREATEST(EXCLUDED.citation_count, papers.citation_count),
    reference_count = COALESCE(EXCLUDED.reference_count, papers.reference_count),
    openalex_id     = COALESCE(EXCLUDED.openalex_id, papers.openalex_id),
    enriched_at     = COALESCE(EXCLUDED.enriched_at, papers.enriched_at),
    row_updated_at  = now()
RETURNING id
"""

UPSERT_VERSION = """
INSERT INTO paper_versions (paper_id, arxiv_id, version, source, published_at)
VALUES (%(paper_id)s, %(arxiv_id)s, %(version)s, 'arxiv', %(published_at)s)
ON CONFLICT (arxiv_id) DO UPDATE SET
    paper_id = EXCLUDED.paper_id,
    version  = EXCLUDED.version
"""

UPSERT_AUTHOR = """
INSERT INTO authors (name) VALUES (%(name)s)
ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name
RETURNING id
"""

LINK_AUTHOR = """
INSERT INTO paper_authors (paper_id, author_id, position)
VALUES (%(paper_id)s, %(author_id)s, %(position)s)
ON CONFLICT (paper_id, author_id) DO UPDATE SET position = EXCLUDED.position
"""

UPSERT_TOPIC = """
INSERT INTO topics (name, source) VALUES (%(name)s, 'openalex')
ON CONFLICT (name, source) DO UPDATE SET name = EXCLUDED.name
RETURNING id
"""

LINK_TOPIC = """
INSERT INTO paper_topics (paper_id, topic_id, score)
VALUES (%(paper_id)s, %(topic_id)s, %(score)s)
ON CONFLICT (paper_id, topic_id) DO UPDATE SET score = EXCLUDED.score
"""


def _version_of(arxiv_id: str) -> int | None:
    """Extract the numeric version from '2610.13935v2'."""
    _, _, tail = arxiv_id.rpartition("v")
    return int(tail) if tail.isdigit() else None


def save_paper(
    conn: psycopg.Connection,
    paper: dict,
    *,
    html_available: bool | None,
    enrichment: dict | None = None,
) -> int:
    """Upsert one paper with its version, authors and topics. Returns the paper id."""
    e = enrichment or {}
    base_id = paper.get("base_id") or paper["arxiv_id"]

    params = {
        "doi": paper.get("doi"),
        "arxiv_base_id": base_id,
        "title": paper["title"],
        "abstract": paper.get("abstract"),
        "venue": e.get("venue"),
        "primary_category": paper.get("primary_category"),
        "categories": paper.get("categories") or [],
        "published_at": _dt(paper.get("published")),
        "arxiv_updated_at": _dt(paper.get("updated")),
        "html_available": html_available,
        "html_url": f"https://arxiv.org/html/{paper['arxiv_id']}" if html_available else None,
        "pdf_url": paper.get("pdf_url"),
        # arXiv itself is a green-OA host, so a PDF link means at least green OA.
        "oa_status": e.get("oa_status") or ("green" if paper.get("pdf_url") else None),
        "citation_count": e.get("cited_by_count") or 0,
        "reference_count": e.get("referenced_works_count"),
        "openalex_id": e.get("openalex_id"),
        "enriched_at": datetime.now(timezone.utc) if enrichment else None,
    }

    with conn.cursor() as cur:
        cur.execute(UPSERT_PAPER, params)
        paper_id = cur.fetchone()["id"]

        cur.execute(
            UPSERT_VERSION,
            {
                "paper_id": paper_id,
                "arxiv_id": paper["arxiv_id"],
                "version": _version_of(paper["arxiv_id"]),
                "published_at": _dt(paper.get("published")),
            },
        )

        for position, name in enumerate(paper.get("authors") or []):
            if not name:
                continue
            cur.execute(UPSERT_AUTHOR, {"name": name})
            author_id = cur.fetchone()["id"]
            cur.execute(
                LINK_AUTHOR,
                {"paper_id": paper_id, "author_id": author_id, "position": position},
            )

        for topic in e.get("topics") or []:
            cur.execute(UPSERT_TOPIC, {"name": topic["name"]})
            topic_id = cur.fetchone()["id"]
            cur.execute(
                LINK_TOPIC,
                {"paper_id": paper_id, "topic_id": topic_id, "score": topic.get("score")},
            )

    return paper_id


def stats(conn: psycopg.Connection) -> dict:
    """Row counts for a quick sanity check after ingestion."""
    out: dict[str, int] = {}
    with conn.cursor() as cur:
        for table in ("papers", "paper_versions", "authors", "topics",
                      "paper_topics", "paper_authors", "users", "events"):
            cur.execute(f"SELECT count(*) AS n FROM {table}")  # noqa: S608 - fixed table list
            out[table] = cur.fetchone()["n"]
        cur.execute(
            "SELECT count(*) AS n FROM papers WHERE html_available IS TRUE"
        )
        out["papers_with_html"] = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM papers WHERE enriched_at IS NOT NULL")
        out["papers_enriched"] = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM papers WHERE embedding IS NOT NULL")
        out["papers_embedded"] = cur.fetchone()["n"]
    return out


# --------------------------------------------------------------------------
# Migrations
# --------------------------------------------------------------------------

MIGRATIONS_DIR = ROOT / "db" / "migrations"


def apply_migrations(conn: psycopg.Connection, path: Path = MIGRATIONS_DIR) -> list[str]:
    """Apply numbered .sql migrations in filename order, at most once each."""
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    conn.commit()

    files = sorted(path.glob("*.sql")) if path.exists() else []
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations")
        done = {row["version"] for row in cur.fetchall()}

    applied: list[str] = []
    for f in files:
        if f.name in done:
            continue
        with conn.cursor() as cur:
            cur.execute(f.read_text())
            cur.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (f.name,))
        conn.commit()
        applied.append(f.name)
    return applied


# --------------------------------------------------------------------------
# Embeddings
# --------------------------------------------------------------------------

def fetch_papers_to_embed(
    conn: psycopg.Connection, *, limit: int | None = None, only_missing: bool = True
) -> list[dict]:
    """The embedding work queue, newest papers first."""
    where = "WHERE embedding IS NULL" if only_missing else ""
    sql = f"""
        SELECT id, title, abstract
          FROM papers
          {where}
         ORDER BY published_at DESC NULLS LAST
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    with conn.cursor() as cur:
        cur.execute(sql)
        return cur.fetchall()


def _vector_literal(vec) -> str:
    """pgvector accepts a '[a,b,c]' text literal, which avoids an extra dependency."""
    return "[" + ",".join(f"{float(x):.7g}" for x in vec) + "]"


def save_embeddings(conn: psycopg.Connection, papers: list[dict], vectors, model: str) -> int:
    """Persist vectors. Callers must pass L2-normalized vectors."""
    rows = [(_vector_literal(v), model, p["id"]) for p, v in zip(papers, vectors)]
    with conn.cursor() as cur:
        cur.executemany(
            """
            UPDATE papers
               SET embedding       = %s::vector,
                   embedding_model = %s,
                   embedded_at     = now()
             WHERE id = %s
            """,
            rows,
        )
    conn.commit()
    return len(rows)
