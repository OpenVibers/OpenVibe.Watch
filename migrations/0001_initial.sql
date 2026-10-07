-- phase: expand
-- OpenVibe.Watch on PostgreSQL (ADR-035). Additive only; never edited after it runs.
--
-- The whole model on purpose (plan T18 step 2): the watch registry, where each watch's conditional
-- fetch state lives, what every check recorded as a run and as an observation, and the outbox that
-- carries watch.observation.recorded / watch.watch.triggered / watch.check.failed. Later steps of
-- T18 (actions, event and webhook carriers, Run) add code, not tables.

CREATE TABLE watches (
    id            text COLLATE "C" PRIMARY KEY,        -- wch_<ULID>
    project_id    text COLLATE "C",
    owner_sub     text COLLATE "C" NOT NULL,           -- usr_… / agt_… / svc:…
    name          text COLLATE "C" NOT NULL,
    status        text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled','failed')),
    source        jsonb NOT NULL,                      -- watch.watch@1 source (validated in code against the contract)
    cadence       jsonb,                               -- {every_sec,jitter_sec,timezone}; NULL for event/webhook
    extraction    jsonb NOT NULL DEFAULT '{}',
    comparison    jsonb,
    condition     jsonb NOT NULL DEFAULT '{}',
    action        jsonb NOT NULL DEFAULT '[]',
    budget        jsonb NOT NULL DEFAULT '{}',
    retention     jsonb NOT NULL DEFAULT '{}',
    labels        jsonb NOT NULL DEFAULT '{}',
    -- runtime state
    next_due_at   bigint NOT NULL DEFAULT 0,
    not_before    bigint NOT NULL DEFAULT 0,           -- Retry-After / rate-limit wait
    last_check_at bigint,
    last_success_at bigint,
    last_state    text COLLATE "C",
    consecutive_failures bigint NOT NULL DEFAULT 0,
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    updated_by    text COLLATE "C",
    deleted_at    bigint
);
CREATE INDEX idx_watches_due   ON watches (next_due_at) WHERE status = 'active' AND deleted_at IS NULL AND cadence IS NOT NULL;
CREATE INDEX idx_watches_owner ON watches (owner_sub, created_at DESC);

CREATE TABLE watch_endpoint_state (
    watch_id      text COLLATE "C" NOT NULL,
    url           text COLLATE "C" NOT NULL,
    etag          text COLLATE "C",
    last_modified text COLLATE "C",
    last_status   bigint,
    last_fetch_at bigint,
    last_body_hash text COLLATE "C",
    PRIMARY KEY (watch_id, url)
);

CREATE TABLE check_runs (
    rid            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id             text COLLATE "C" NOT NULL UNIQUE,   -- ckr_<ULID>
    watch_id       text COLLATE "C" NOT NULL,
    trigger        text COLLATE "C" NOT NULL CHECK (trigger IN ('schedule','manual','event','webhook')),
    carrier        text COLLATE "C",                   -- event|webhook|http|feed|api|node|run
    started_at     bigint NOT NULL,
    finished_at    bigint NOT NULL,
    state          text COLLATE "C" NOT NULL CHECK (state IN ('ok','not_modified','no_change','changed','condition_met','http_error','timeout','parse_error','rate_limited','budget_exceeded','skipped','disabled')),
    http_status    bigint,
    error_code     text COLLATE "C",
    detail         text COLLATE "C",
    bytes          bigint,
    raw_body_hash  text COLLATE "C",
    cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
    observations   bigint NOT NULL DEFAULT 0,
    triggers       bigint NOT NULL DEFAULT 0
);
CREATE INDEX idx_check_runs_watch ON check_runs (watch_id, rid DESC);

CREATE TABLE observations (
    rid            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id             text COLLATE "C" NOT NULL UNIQUE,   -- wco_<ULID>
    watch_id       text COLLATE "C" NOT NULL,
    check_run_id   text COLLATE "C" NOT NULL,
    observed_at    bigint NOT NULL,
    value          jsonb NOT NULL,
    value_hash     text COLLATE "C" NOT NULL,
    previous_hash  text COLLATE "C",
    changed        bigint NOT NULL DEFAULT 0,
    condition_met  bigint NOT NULL DEFAULT 0,
    snapshot       text COLLATE "C",
    retained_until bigint
);
CREATE INDEX idx_observations_watch  ON observations (watch_id, rid DESC);
CREATE INDEX idx_observations_retain ON observations (retained_until);

CREATE TABLE counters ( name text COLLATE "C" PRIMARY KEY, value bigint NOT NULL );

-- server/events/outbox.js ensureSchema() (identical to OpenVibe.Sources)
CREATE TABLE event_outbox (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text COLLATE "C" NOT NULL UNIQUE, event_type text COLLATE "C" NOT NULL,
    envelope text COLLATE "C" NOT NULL, created_at bigint NOT NULL,
    attempts bigint NOT NULL DEFAULT 0, next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at bigint, rejected_at bigint, last_error text COLLATE "C"
);
CREATE INDEX idx_event_outbox_due ON event_outbox(sent_at, rejected_at, next_attempt_at);
