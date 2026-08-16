-- ============================================================
-- Newtrition — Phase 6: authentication & ownership
-- Apply AFTER schema.sql. Safe to run on an existing database.
-- ============================================================

-- Roles decide what a signed-in person may do. Only an owner may create
-- accounts or sign off on nutrition values.
DO $$ BEGIN
  CREATE TYPE clinician_role AS ENUM ('owner', 'clinician', 'assistant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE clinician ADD COLUMN IF NOT EXISTS role         clinician_role NOT NULL DEFAULT 'clinician';
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Email is the login identifier, so it must match case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinician_email_lower ON clinician (lower(email));

-- ---------- Sessions ----------
-- The raw token never touches the database; only its SHA-256 hash is stored,
-- so a database leak cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS session (
    id           BIGSERIAL PRIMARY KEY,
    clinician_id BIGINT NOT NULL REFERENCES clinician(id) ON DELETE CASCADE,
    token_hash   TEXT UNIQUE NOT NULL,
    user_agent   TEXT,
    ip           TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_lookup ON session (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_clinician ON session (clinician_id);

-- ---------- Login throttling ----------
-- Records every attempt so repeated failures can be slowed down.
CREATE TABLE IF NOT EXISTS login_attempt (
    id          BIGSERIAL PRIMARY KEY,
    email       TEXT NOT NULL,
    ip          TEXT,
    successful  BOOLEAN NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_recent ON login_attempt (email, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip_recent ON login_attempt (ip, attempted_at DESC);

-- ---------- Ownership ----------
-- Every plan belongs to a clinician through its client, so a query that forgets
-- to filter cannot silently return another clinician's data.
CREATE OR REPLACE VIEW v_plan_owner AS
SELECT p.id AS plan_id, c.clinician_id, c.id AS client_id
FROM plan p JOIN client c ON c.id = p.client_id;

-- Audit: who changed nutrition values and when.
CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL PRIMARY KEY,
    clinician_id BIGINT REFERENCES clinician(id),
    action       TEXT NOT NULL,
    target       TEXT,
    detail       TEXT,
    ip           TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log (created_at DESC);

-- v3.1: operational cleanup indexes
CREATE INDEX IF NOT EXISTS idx_session_expires ON session (expires_at);
