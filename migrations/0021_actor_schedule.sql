-- phase: expand
-- A watch that runs a routine instead of watching a page: the five-field cron (in the watch's timezone)
-- Actor saves after creating the subscription. It is separate from cadence because a routine has no source
-- to fetch; the scheduler fires an action and records the run, and nothing polls.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS schedule jsonb;
CREATE INDEX IF NOT EXISTS idx_watches_schedule_due ON watches (next_due_at)
    WHERE status = 'active' AND deleted_at IS NULL AND schedule IS NOT NULL;
