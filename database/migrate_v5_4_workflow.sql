-- Newtrition V5.4 clinician workflow: draft -> in_review -> approved -> superseded
ALTER TABLE plan ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE plan ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE plan ADD CONSTRAINT plan_workflow_status_chk CHECK (workflow_status IN ('DRAFT','IN_REVIEW','APPROVED','SUPERSEDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_plan_client_workflow ON plan (client_id, workflow_status, version DESC);
