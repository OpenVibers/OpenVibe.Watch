-- phase: expand
-- When a watch was first armed. A watch the site creates to run its quiet test is paused with
-- armed_at NULL: the test check is the only read, and resuming (arming) sets it. Watches that
-- existed before this column were armed at creation, so they are backfilled rather than shown as
-- untested: nothing about a watch already in the registry is invented.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS armed_at bigint;
UPDATE watches SET armed_at = created_at WHERE armed_at IS NULL;
