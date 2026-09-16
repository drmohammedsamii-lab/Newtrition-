-- V8.12 — AI-generated plan items require individual approval, not a single
-- blanket approval for the whole plan. The optimizer/engine still computes
-- all nutrition values (unchanged) — this only gates the WORKFLOW: a plan
-- containing AI-drafted items cannot move to APPROVED until every one of
-- those items has been explicitly signed off by the clinician.
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS ai_approved  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS ai_approved_by BIGINT REFERENCES clinician(id);
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS ai_approved_at TIMESTAMPTZ;
