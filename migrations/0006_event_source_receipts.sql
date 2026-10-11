-- phase: expand
-- OpenVibe.Watch: event sources (plan T18 step 5, server/event-sources.js). OpenVibe.Events delivers at least once, so
-- each event a watch's event source handled is recorded once by its id: a second delivery of it is a duplicate and
-- wakes no watch again. Pruned after seven days (Events' replay window is shorter).

CREATE TABLE event_source_receipts (
    event_id     text COLLATE "C" PRIMARY KEY,
    event_type   text NOT NULL,
    received_at  bigint NOT NULL,                -- ms since the epoch
    watches      integer NOT NULL DEFAULT 0      -- the watches it woke
);
CREATE INDEX event_source_receipts_received ON event_source_receipts (received_at);
