-- phase: expand
-- OpenVibe.Watch email in (agent plan A3): a watch's email address (provider 'email') is its key, kept in
-- webhook_secrets.secret as the address's local part (in-<26 characters>). Mail to the address finds its watch by it.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_secrets_email_address ON webhook_secrets (secret) WHERE provider = 'email';
