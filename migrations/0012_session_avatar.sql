-- phase: expand
-- The shared navbar shows the signed-in person's avatar from /auth/me (server/auth/sso.js): the session keeps the
-- avatar and colour Network's token carried at sign-in, as the other sites' sessions do (2026-10-22: every scaffolded
-- site answered /auth/me without them, so the navbar drew an initial). Nullable and additive: an older release never
-- reads them.
ALTER TABLE web_sessions ADD COLUMN IF NOT EXISTS avatar_url text COLLATE "C";
ALTER TABLE web_sessions ADD COLUMN IF NOT EXISTS profile_color text COLLATE "C";
