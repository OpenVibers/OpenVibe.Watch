-- phase: contract
-- after: 0004
-- The SDK outbox (service_outbox, migration 0004, 2026-10-10) has carried every Watch event since; no code reads
-- event_outbox, and it was empty when this was written (2026-10-23).
DROP TABLE IF EXISTS event_outbox;
