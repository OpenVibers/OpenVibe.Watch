-- phase: expand
-- ADR-056: a watch that names a project looks its project secrets (secret_ref: a source credential, a webhook action's
-- signing key) up in this environment of that project. production by default when a project is named, NULL without one.
-- Additive: an older release never reads the column.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS project_env text COLLATE "C";
