-- phase: expand
-- OpenVibe.Watch YouTube (agent plan A5): a webhook watch can follow a YouTube channel through YouTube's WebSub hub
-- (provider 'youtube'). `topic` is the channel's feed the hub was asked for, and `lease_until` (ms) when the hub's
-- subscription ends, so Watch renews it before then. Other providers leave both NULL.
ALTER TABLE webhook_secrets ADD COLUMN IF NOT EXISTS topic text;
ALTER TABLE webhook_secrets ADD COLUMN IF NOT EXISTS lease_until bigint;
