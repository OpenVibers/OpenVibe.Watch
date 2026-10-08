-- phase: expand
-- The public site's sign-in sessions (plan T18 step 8). Additive only; never edited after it runs.
--
-- A signed-in person's browser holds an opaque random token in an httpOnly cookie; only its SHA-256
-- hash is stored here, so a database dump does not hand out live sessions. The person's Network
-- access token is NOT stored: after the OAuth code exchange we verify it once (issuer, audience,
-- subject) and keep only the canonical subject the watches belong to. The subject is what the
-- registry scopes ownership by (usr_…/agt_…), the same authority the API applies.

CREATE TABLE web_sessions (
    id            text COLLATE "C" PRIMARY KEY,        -- sha256 hex of the cookie token
    subject       text COLLATE "C" NOT NULL,           -- usr_… / agt_…
    username      text COLLATE "C",
    display_name  text COLLATE "C",
    role          text COLLATE "C",
    created_at    bigint NOT NULL,
    last_seen_at  bigint NOT NULL,
    expires_at    bigint NOT NULL,
    revoked_at    bigint
);
CREATE INDEX idx_web_sessions_expiry ON web_sessions (expires_at);
CREATE INDEX idx_web_sessions_subject ON web_sessions (subject, created_at DESC);
