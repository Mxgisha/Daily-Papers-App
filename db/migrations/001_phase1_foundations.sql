-- Phase 1 schema changes.
--
-- Four gaps that Phase 0 surfaced and that are cheap to fix now, annoying later.

-- 1. Track which encoder produced each embedding. Without this you cannot
--    selectively re-embed after a model swap; you would have to guess which
--    rows came from which model.
ALTER TABLE papers ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS embedded_at     TIMESTAMPTZ;

-- Work queue for the embedding worker: only un-embedded rows, so the partial
-- index stays small even as the corpus grows.
CREATE INDEX IF NOT EXISTS papers_needs_embedding_idx
    ON papers (published_at DESC) WHERE embedding IS NULL;

-- 2. Device-first onboarding. An anonymous user has no email address, so the
--    original NOT NULL constraint made anonymous users impossible -- which
--    would have cost us exactly the telemetry the recommender needs.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT true;

-- 3. Mobile clients batch events and retry on flaky networks. Without an
--    idempotency key, retries double-count engagement and poison the training
--    data in a way that is very hard to detect after the fact.
ALTER TABLE events ADD COLUMN IF NOT EXISTS client_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_client_event_id_key
    ON events (client_event_id) WHERE client_event_id IS NOT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS ts_client TIMESTAMPTZ;

-- 4. Refresh tokens, stored hashed so a database leak does not hand over
--    live sessions.
CREATE TABLE IF NOT EXISTS sessions (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_hash  TEXT NOT NULL UNIQUE,
    device_name   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
