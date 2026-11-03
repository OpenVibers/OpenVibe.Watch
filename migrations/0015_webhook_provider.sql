-- phase: expand
-- OpenVibe.Watch: a webhook watch may be signed by the sender's own secret (agent plan A3, triggers v1). Slack signs
-- with the app's signing secret and Stripe with the endpoint's secret, both made by them, not by Watch: the person
-- pastes it, and `provider` says which scheme checks it (server/webhook-sources.js). NULL is Watch's own whk_ secret,
-- as before. The secret is needed in full to check a signature, so it is stored as Watch's own is.
ALTER TABLE webhook_secrets ADD COLUMN IF NOT EXISTS provider text;
