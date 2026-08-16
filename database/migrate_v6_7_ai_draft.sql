-- Newtrition V6.7 AI -> Draft Plan workflow
ALTER TABLE plan ADD COLUMN IF NOT EXISTS ai_intent JSONB;
CREATE INDEX IF NOT EXISTS idx_plan_client_draft ON plan (client_id, workflow_status, version DESC);
