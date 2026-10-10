-- phase: expand
-- OpenVibe.Watch: openvibe-sdk/events service outbox. The old event_outbox remains for rollback;
-- a contract migration drops it after the N-1 window.

CREATE TABLE IF NOT EXISTS service_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS service_outbox_due ON service_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS service_outbox_sent ON service_outbox (sent_at) WHERE sent_at IS NOT NULL;

INSERT INTO service_outbox (event_id, envelope, created_at, attempts, next_attempt_at)
SELECT event_id, envelope::jsonb, created_at, attempts, next_attempt_at
FROM event_outbox WHERE sent_at IS NULL AND rejected_at IS NULL
ON CONFLICT (event_id) DO NOTHING;
