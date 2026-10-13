-- phase: expand
-- Plan T5 step 14 (govern universal), Watch slice: the outbox of platform.usage-sample@1 readings Watch posts to
-- OpenVibe.Billing (POST /api/v1/usage, capability billing.usage.record; server/billing.js), one per completed
-- check run (metric check-operation).
--
-- billing_readings is the openvibe-sdk/usage createUsageReporter outbox (outboxSchema('billing_readings')): one row per
-- reading, `event_id` is the reading's idempotency_key (watch:check:<check run id>; unique, so a retried or replayed
-- run inserts nothing, ON CONFLICT DO NOTHING) and `envelope` is the reading JSON. The reporter only ever moves the
-- sending columns (attempts, next_attempt_at, sent_at, seq, rejected_at, last_error); the trigger below refuses any
-- change to the reading itself, so a retry always posts the same body and Billing's idempotency key sees the same
-- reading. A check is counted, not aggregated: no period table is needed.
-- Additive only: one new table, its indexes and its trigger; nothing existing changes.
CREATE TABLE billing_readings (
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
    last_error      text,
    -- `event_id` IS the reading's idempotency_key; this generated column names it so a reader can say so.
    idempotency_key text GENERATED ALWAYS AS (event_id) STORED
);
CREATE INDEX IF NOT EXISTS billing_readings_due ON billing_readings (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS billing_readings_sent ON billing_readings (sent_at) WHERE sent_at IS NOT NULL;

-- A reading is never edited: only its delivery columns move. event_id/envelope/created_at are the reading.
CREATE FUNCTION billing_readings_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.envelope IS DISTINCT FROM OLD.envelope
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'billing_readings: reading % is never edited', OLD.event_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER billing_readings_frozen BEFORE UPDATE ON billing_readings FOR EACH ROW EXECUTE FUNCTION billing_readings_frozen();
