-- Daily Papers App — core schema
--
-- Design notes that matter:
--
--  * `papers` models the WORK; `paper_versions` models the arXiv submission. A preprint and
--    its published version are one work with two versions. Without this split the feed shows
--    users the same paper twice and splits the engagement signal that trains the recommender.
--
--  * `feed_impressions` is not optional. Without logged impressions you cannot distinguish
--    "user ignored this because it is irrelevant" from "user never saw it because we ranked it
--    90th". Every offline evaluation of the recommender depends on this table, and it cannot
--    be backfilled.
--
--  * `reading_state.locator` is deliberately opaque JSONB: {renderer:"html", block:42} or
--    {renderer:"pdf", page:7, y:0.31}. This lets a reader resume across devices AND across a
--    format switch without a migration.
--
--  * `embedding` is nullable at this stage. SPECTER2 embedding is a separate batch step and
--    ingestion must not be blocked on a GPU.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Papers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS papers (
    id                  BIGSERIAL PRIMARY KEY,
    doi                 TEXT UNIQUE,
    arxiv_base_id       TEXT UNIQUE,          -- version-stripped, e.g. '2610.13935'
    title               TEXT NOT NULL,
    abstract            TEXT,
    tldr                TEXT,
    venue               TEXT,
    primary_category    TEXT,
    categories          TEXT[] NOT NULL DEFAULT '{}',
    published_at        TIMESTAMPTZ,
    arxiv_updated_at    TIMESTAMPTZ,
    -- Reader strategy: HTML full text is the primary path, PDF the fallback.
    html_available      BOOLEAN,
    html_url            TEXT,
    pdf_url             TEXT,
    oa_status           TEXT,
    citation_count      INT NOT NULL DEFAULT 0,
    reference_count     INT,
    openalex_id         TEXT,
    embedding           vector(768),          -- SPECTER2; filled by a later batch step
    enriched_at         TIMESTAMPTZ,          -- last successful OpenAlex enrichment
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    row_updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily feed: recent papers filtered by category.
CREATE INDEX IF NOT EXISTS papers_published_idx ON papers (published_at DESC);
CREATE INDEX IF NOT EXISTS papers_categories_idx ON papers USING gin (categories);
-- Cross-source dedup when the same work arrives under a different identifier.
CREATE INDEX IF NOT EXISTS papers_title_trgm_idx ON papers USING gin (title gin_trgm_ops);
-- ANN search for content-based recommendation. HNSW over cosine distance.
CREATE INDEX IF NOT EXISTS papers_embedding_idx
    ON papers USING hnsw (embedding vector_cosine_ops);
-- Papers still needing enrichment (partial index keeps it small).
CREATE INDEX IF NOT EXISTS papers_needs_enrichment_idx
    ON papers (created_at) WHERE enriched_at IS NULL;

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS paper_versions (
    id              BIGSERIAL PRIMARY KEY,
    paper_id        BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    arxiv_id        TEXT UNIQUE NOT NULL,     -- versioned, e.g. '2610.13935v2'
    version         INT,
    source          TEXT NOT NULL DEFAULT 'arxiv',
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (paper_id, version)
);

CREATE INDEX IF NOT EXISTS paper_versions_paper_idx ON paper_versions (paper_id);

-- ---------------------------------------------------------------------------
-- Authors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS authors (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    orcid       TEXT UNIQUE,
    h_index     INT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS authors_name_key ON authors (lower(name));

CREATE TABLE IF NOT EXISTS paper_authors (
    paper_id    BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    author_id   BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    position    INT NOT NULL,
    PRIMARY KEY (paper_id, author_id)
);

CREATE INDEX IF NOT EXISTS paper_authors_author_idx ON paper_authors (author_id);

-- ---------------------------------------------------------------------------
-- Topics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS topics (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'openalex',
    parent_id   BIGINT REFERENCES topics(id) ON DELETE SET NULL,
    UNIQUE (name, source)
);

CREATE TABLE IF NOT EXISTS paper_topics (
    paper_id    BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    topic_id    BIGINT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    score       REAL,
    PRIMARY KEY (paper_id, topic_id)
);

CREATE INDEX IF NOT EXISTS paper_topics_topic_idx ON paper_topics (topic_id);

-- ---------------------------------------------------------------------------
-- Users and library
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id                  BIGSERIAL PRIMARY KEY,
    email               TEXT UNIQUE NOT NULL,
    display_name        TEXT,
    -- Seed papers chosen at onboarding: the entire cold-start fuel supply.
    onboarding_seeds    JSONB NOT NULL DEFAULT '[]'::jsonb,
    prefs               JSONB NOT NULL DEFAULT '{}'::jsonb,
    push_hour_local     INT,
    timezone            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collections (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS collection_items (
    collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    paper_id      BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, paper_id)
);

CREATE TABLE IF NOT EXISTS reading_state (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paper_id        BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'unread'
                    CHECK (status IN ('unread', 'reading', 'read', 'archived')),
    progress_pct    REAL NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 1),
    locator         JSONB,          -- renderer-agnostic resume point
    total_dwell_ms  BIGINT NOT NULL DEFAULT 0,
    last_read_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, paper_id)
);

-- "Continue reading" shelf.
CREATE INDEX IF NOT EXISTS reading_state_continue_idx
    ON reading_state (user_id, last_read_at DESC)
    WHERE status = 'reading';

-- ---------------------------------------------------------------------------
-- Telemetry: the recommender's training data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
    paper_id    BIGINT REFERENCES papers(id) ON DELETE SET NULL,
    type        TEXT NOT NULL,
    session_id  TEXT,
    position    INT,                -- position in feed, when applicable
    dwell_ms    BIGINT,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_user_ts_idx ON events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_paper_idx ON events (paper_id);
CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts DESC);

-- Impressions MUST be logged or the recommender cannot be evaluated without bias.
CREATE TABLE IF NOT EXISTS feed_impressions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paper_id        BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    feed_date       DATE NOT NULL,
    rank            INT NOT NULL,
    score           REAL,
    model_version   TEXT NOT NULL,
    clicked         BOOLEAN NOT NULL DEFAULT false,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, paper_id, feed_date)
);

CREATE INDEX IF NOT EXISTS feed_impressions_user_date_idx
    ON feed_impressions (user_id, feed_date DESC);
CREATE INDEX IF NOT EXISTS feed_impressions_model_idx
    ON feed_impressions (model_version, feed_date);

-- ---------------------------------------------------------------------------
-- Convenience view: what the reader will actually render
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW readable_papers AS
SELECT
    p.id,
    p.arxiv_base_id,
    p.title,
    p.abstract,
    p.published_at,
    p.primary_category,
    p.categories,
    p.html_available,
    p.html_url,
    p.pdf_url,
    p.citation_count,
    CASE
        WHEN p.html_available THEN 'html'
        WHEN p.pdf_url IS NOT NULL THEN 'pdf'
        ELSE 'none'
    END AS reader_mode
FROM papers p;
