-- Newtrition V7.0 client portal
CREATE TABLE IF NOT EXISTS client_account (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL UNIQUE REFERENCES client(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS client_session (
  id BIGSERIAL PRIMARY KEY,
  client_account_id BIGINT NOT NULL REFERENCES client_account(id) ON DELETE CASCADE,
  client_id BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_client_session_lookup ON client_session(token_hash) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS client_audit_log (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT REFERENCES client(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
