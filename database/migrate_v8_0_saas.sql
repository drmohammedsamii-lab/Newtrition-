-- Newtrition V8.0 SaaS foundation
CREATE TABLE IF NOT EXISTS organization (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organization(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clinician_org ON clinician(organization_id);
CREATE TABLE IF NOT EXISTS subscription (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TRIAL',
  current_period_end TIMESTAMPTZ,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','CANCELED','PAUSED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_active_org ON subscription(organization_id) WHERE status IN ('TRIAL','ACTIVE','PAST_DUE','PAUSED');
CREATE TABLE IF NOT EXISTS organization_entitlement (
  organization_id BIGINT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  limit_value BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY(organization_id,feature_code)
);
