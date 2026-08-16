-- Newtrition V5.2: explainability + targeted repair metadata
ALTER TABLE plan ADD COLUMN IF NOT EXISTS explainability JSONB;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS repair_scope TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS repair_day_index INT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS repair_slot TEXT;

CREATE TABLE IF NOT EXISTS plan_repair_event (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT REFERENCES plan(id) ON DELETE CASCADE,
  clinician_id BIGINT REFERENCES clinician(id),
  scope TEXT NOT NULL,
  day_index INT,
  slot TEXT,
  before_score NUMERIC,
  after_score NUMERIC,
  improved BOOLEAN NOT NULL DEFAULT FALSE,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_repair_event_plan ON plan_repair_event(plan_id, created_at DESC);
