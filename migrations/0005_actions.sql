-- phase: expand
-- OpenVibe.Watch: the actions a fired condition sets in motion (plan T18 step 4, server/actions.js). One row per action
-- of the watch per trigger, written in the same transaction as the check run that fired, so a trigger queues each of
-- its actions exactly once; the action worker delivers the queued ones (notifications today) and records the outcome.
-- request holds what will be delivered (for a notification: network.notification-push-request@1 fields, never a
-- token or a secret).

CREATE TABLE action_runs (
    rid             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    watch_id        text COLLATE "C" NOT NULL,
    check_run_id    text COLLATE "C" NOT NULL,           -- ckr_<ULID>: the run that fired
    action_index    integer NOT NULL,                    -- its place in the watch's action list
    kind            text COLLATE "C" NOT NULL,           -- notification | event | webhook | actor-task | codes-run | run-job
    owner_sub       text COLLATE "C" NOT NULL,
    request         jsonb NOT NULL DEFAULT '{}',
    state           text COLLATE "C" NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'sent', 'skipped', 'failed', 'unavailable')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    last_error      text COLLATE "C",
    created_at      bigint NOT NULL,
    finished_at     bigint,
    UNIQUE (check_run_id, action_index)
);
CREATE INDEX action_runs_due ON action_runs (next_attempt_at, rid) WHERE state = 'queued';
CREATE INDEX action_runs_watch ON action_runs (watch_id, rid DESC);
