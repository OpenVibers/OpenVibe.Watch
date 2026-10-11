-- phase: expand
-- OpenVibe.Watch: webhook sources (plan T18 step 5, server/webhook-sources.js). A webhook watch is woken by a POST to
-- https://openvibe.watch/hooks/<watch id>, signed with the watch's own secret (HMAC-SHA256 of the body, or the secret
-- as a bearer token). The secret is shown once, when the watch is created or the secret rotated, and is needed here in
-- full to check a signature. It goes with its watch (removal, account deletion).

CREATE TABLE webhook_secrets (
    watch_id    text COLLATE "C" PRIMARY KEY,
    secret      text NOT NULL,
    created_at  bigint NOT NULL
);
