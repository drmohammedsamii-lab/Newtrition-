-- Newtrition V8.5.3 — client profile completeness.
--
-- The client record could store a name, gender, birth_year, height_cm and
-- goal, but never weight, activity level, or a protein target — the exact
-- inputs the Mifflin-St Jeor calculation on the client needs. In practice
-- this meant: create a client with a name only -> open her later -> the
-- weight field silently falls back to the HTML form's hardcoded default
-- (80 kg) with no indication that it is not her real weight.
--
-- This migration adds the missing inputs, plus a snapshot of the last
-- computed targets so re-opening a client shows her numbers immediately
-- instead of nothing.

BEGIN;

ALTER TABLE client ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,1);
ALTER TABLE client ADD COLUMN IF NOT EXISTS activity_level NUMERIC(4,3);
ALTER TABLE client ADD COLUMN IF NOT EXISTS protein_g_per_kg NUMERIC(3,1);

ALTER TABLE client ADD CONSTRAINT client_weight_kg_range
  CHECK (weight_kg IS NULL OR weight_kg BETWEEN 20 AND 400);
ALTER TABLE client ADD CONSTRAINT client_activity_level_range
  CHECK (activity_level IS NULL OR activity_level BETWEEN 1.0 AND 2.2);
ALTER TABLE client ADD CONSTRAINT client_protein_g_per_kg_range
  CHECK (protein_g_per_kg IS NULL OR protein_g_per_kg BETWEEN 0.5 AND 4.0);

-- Snapshot of the last calcTargets() result, so a returning client's card
-- shows real numbers without forcing a recalculation first.
ALTER TABLE client ADD COLUMN IF NOT EXISTS computed_targets JSONB;
ALTER TABLE client ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ;

COMMIT;
