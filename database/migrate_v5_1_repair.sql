-- Newtrition V5.1: repair-attempt metadata.
ALTER TABLE plan ADD COLUMN IF NOT EXISTS repair_status TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS repair_attempts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS repair_summary JSONB;
CREATE INDEX IF NOT EXISTS idx_plan_repair_status ON plan (repair_status);
