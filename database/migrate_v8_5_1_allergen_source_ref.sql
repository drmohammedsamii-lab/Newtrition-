-- migrate_v8_5_1_allergen_source_ref.sql
-- Newtrition V8.5.1 — allergen provenance fix
--
-- Two real defects found by running populate-allergens.js against a freshly
-- migrated database:
--
--   1. populate-allergens.js writes food_allergen.source_ref, but no migration
--      ever created that column. The script aborted with:
--         ERROR: column "source_ref" of relation "food_allergen" does not exist
--      Result: the entire allergen catalogue stayed empty (1966/1966 UNKNOWN),
--      which the safety engine treats as "exclude everything".
--
--   2. Two CHECK constraints on food_allergen.confidence disagreed.
--      food_allergen_confidence_chk (older) omits 'verified_source', while
--      food_allergen_allowed_confidence_chk (newer) permits it. Because CHECKs
--      are ANDed, writing 'verified_source' — a value the application produces —
--      would always fail. The stale narrower constraint is dropped.
--
-- Non-destructive: no allergen rows are deleted or downgraded.

ALTER TABLE food_allergen
  ADD COLUMN IF NOT EXISTS source_ref TEXT;

ALTER TABLE food_allergen
  ADD COLUMN IF NOT EXISTS inferred_at TIMESTAMPTZ DEFAULT now();

-- Drop the stale, narrower constraint. The newer
-- food_allergen_allowed_confidence_chk remains and is authoritative.
ALTER TABLE food_allergen
  DROP CONSTRAINT IF EXISTS food_allergen_confidence_chk;

-- Ensure the authoritative constraint exists even on databases that were
-- migrated in a different order.
DO $$ BEGIN
  ALTER TABLE food_allergen ADD CONSTRAINT food_allergen_allowed_confidence_chk
    CHECK (confidence IN ('explicit_label','name_keyword','inferred_pattern',
                          'clinician_added','verified_source'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_food_allergen_source_ref
  ON food_allergen(source_ref);
