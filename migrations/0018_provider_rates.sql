-- phase: expand
-- Provider-rate evidence (plan P6; flag WATCH_PROVIDER_RATES, off by default): the official price documents of the
-- providers OpenVibe may buy inference from, the rates each document stated, and the changes a person approves.
--
-- This is EVIDENCE, not a rate card. There is no billable price here and no writer for one: an approved change is a
-- dated record of what the provider published and who accepted it, which OpenVibe.AI's operator then applies to the
-- catalog's supply rate card through AI's own path. "Without a second authority."
--
-- nano_usd_per_m is an integer string (D1: integer nano-USD, never a float) per million tokens, for one token class.
-- A malformed document writes no observation at all — never a zero.

CREATE TABLE provider_rate_sources (
    key                  text COLLATE "C" PRIMARY KEY,
    kind                 text COLLATE "C" NOT NULL DEFAULT 'provider-rate' CHECK (kind = 'provider-rate'),
    provider             text COLLATE "C" NOT NULL,
    name                 text COLLATE "C" NOT NULL,
    url                  text COLLATE "C" NOT NULL,          -- the official document fetched
    homepage_url         text COLLATE "C",
    currency             text COLLATE "C" NOT NULL,          -- the document's currency (USD)
    region               text COLLATE "C" NOT NULL,          -- the document's scope (global: not region-gated)
    terms_note           text COLLATE "C" NOT NULL,          -- why reading the document is permitted; a person re-reads it
    robots_note          text COLLATE "C" NOT NULL,          -- the host's robots.txt at the recorded check
    parser_version       text COLLATE "C" NOT NULL,
    enabled              bigint NOT NULL DEFAULT 0,          -- off until a person enables a source, even with the flag on
    poll_interval_sec    bigint NOT NULL,
    stale_after_sec      bigint NOT NULL,
    -- runtime state
    next_due_at          bigint NOT NULL DEFAULT 0,
    not_before           bigint NOT NULL DEFAULT 0,          -- Retry-After
    last_fetch_at        bigint,
    last_success_at      bigint,
    last_state           text COLLATE "C",
    consecutive_failures bigint NOT NULL DEFAULT 0,
    etag                 text COLLATE "C",
    last_modified        text COLLATE "C",
    last_body_hash       text COLLATE "C",
    created_at           bigint NOT NULL,
    updated_at           bigint NOT NULL,
    updated_by           text COLLATE "C"
);

-- One row per fetch attempt, whatever happened. A failed fetch writes no observation and no change.
CREATE TABLE provider_rate_fetches (
    rid           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id            text COLLATE "C" NOT NULL UNIQUE,          -- prf_<ULID>
    source_key    text COLLATE "C" NOT NULL,
    trigger       text COLLATE "C" NOT NULL CHECK (trigger IN ('schedule','manual')),
    started_at    bigint NOT NULL,
    finished_at   bigint NOT NULL,
    state         text COLLATE "C" NOT NULL CHECK (state IN ('ok','not_modified','http_error','timeout','parse_error','rate_limited','disabled')),
    http_status   bigint,
    error_code    text COLLATE "C",
    detail        text COLLATE "C",
    bytes         bigint,
    raw_body_hash text COLLATE "C",
    parser_version text COLLATE "C",
    stated        bigint NOT NULL DEFAULT 0,          -- rates the document stated
    observations  bigint NOT NULL DEFAULT 0,          -- new observations stored (new or changed values)
    changed       bigint NOT NULL DEFAULT 0
);
CREATE INDEX idx_provider_rate_fetches_source ON provider_rate_fetches (source_key, rid DESC);

-- One immutable observation per (model, token class) per successful fetch that stated it.
CREATE TABLE provider_rate_observations (
    rid                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id                    text COLLATE "C" NOT NULL UNIQUE,  -- pro_<ULID>
    source_key            text COLLATE "C" NOT NULL,
    fetch_id              text COLLATE "C" NOT NULL,
    provider              text COLLATE "C" NOT NULL,
    model                 text COLLATE "C" NOT NULL,
    token_class           text COLLATE "C" NOT NULL CHECK (token_class IN ('input','cached_read','cache_write','output')),
    nano_usd_per_m        text COLLATE "C" NOT NULL CHECK (nano_usd_per_m ~ '^[0-9]+$'),  -- D1: integer string
    currency              text COLLATE "C" NOT NULL,
    region                text COLLATE "C" NOT NULL,
    effective_date        text COLLATE "C" NOT NULL,          -- YYYY-MM-DD; the first day this value was observed
    source_url            text COLLATE "C" NOT NULL,
    fetched_at            bigint NOT NULL,
    value_hash            text COLLATE "C" NOT NULL,          -- hashValue({nano_usd_per_m,currency,region})
    changed               bigint NOT NULL DEFAULT 0,
    previous_id           text COLLATE "C",
    previous_nano_usd_per_m text COLLATE "C"
);
CREATE INDEX idx_provider_rate_observations_key ON provider_rate_observations (source_key, model, token_class, rid DESC);
CREATE INDEX idx_provider_rate_observations_rid ON provider_rate_observations (rid DESC);

-- A change Watch raised for a person to approve: one per observation that differs from the last one.
CREATE TABLE provider_rate_changes (
    rid                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id                    text COLLATE "C" NOT NULL UNIQUE,  -- prc_<ULID>
    source_key            text COLLATE "C" NOT NULL,
    observation_id        text COLLATE "C" NOT NULL,
    previous_id           text COLLATE "C",
    provider              text COLLATE "C" NOT NULL,
    model                 text COLLATE "C" NOT NULL,
    token_class           text COLLATE "C" NOT NULL,
    from_nano_usd_per_m   text COLLATE "C",
    to_nano_usd_per_m     text COLLATE "C" NOT NULL CHECK (to_nano_usd_per_m ~ '^[0-9]+$'),
    currency              text COLLATE "C" NOT NULL,
    region                text COLLATE "C" NOT NULL,
    effective_date        text COLLATE "C" NOT NULL,
    source_url            text COLLATE "C" NOT NULL,
    fetched_at            bigint NOT NULL,
    state                 text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
    created_at            bigint NOT NULL,
    decided_at            bigint,
    decided_by            text COLLATE "C",                   -- a person (usr_…): only a person approves
    note                  text COLLATE "C"
);
CREATE INDEX idx_provider_rate_changes_state ON provider_rate_changes (state, rid DESC);
CREATE INDEX idx_provider_rate_changes_source ON provider_rate_changes (source_key, rid DESC);
