-- Newtrition V5.0: persistent quality gate metadata.
ALTER TABLE plan ADD COLUMN IF NOT EXISTS quality_score NUMERIC(5,1);
ALTER TABLE plan ADD COLUMN IF NOT EXISTS quality_status TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS quality_blockers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS quality_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS optimizer_version TEXT;
CREATE INDEX IF NOT EXISTS idx_plan_quality_status ON plan (quality_status);
