-- Newtrition v3.1 migration for an existing Phase 2/3 database.
-- Run after schema.sql + schema_auth.sql from the previous release.
BEGIN;

ALTER TABLE nutrition_serving ALTER COLUMN status SET DEFAULT 'INCOMPLETE';
UPDATE nutrition_serving
SET status='INCOMPLETE'
WHERE (protein_g IS NULL OR carb_g IS NULL OR fat_g IS NULL)
  AND status='COMPUTABLE';

CREATE TABLE IF NOT EXISTS food_allergen (
  food_item_id BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
  allergen TEXT NOT NULL,
  PRIMARY KEY (food_item_id, allergen)
);
CREATE INDEX IF NOT EXISTS idx_food_allergen_allergen ON food_allergen(allergen);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip_recent ON login_attempt(ip, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='followup_weight_positive') THEN
    ALTER TABLE followup ADD CONSTRAINT followup_weight_positive CHECK (weight_kg IS NULL OR weight_kg > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='followup_waist_positive') THEN
    ALTER TABLE followup ADD CONSTRAINT followup_waist_positive CHECK (waist_cm IS NULL OR waist_cm > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='followup_bodyfat_range') THEN
    ALTER TABLE followup ADD CONSTRAINT followup_bodyfat_range CHECK (body_fat_pct IS NULL OR body_fat_pct BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='followup_adherence_range') THEN
    ALTER TABLE followup ADD CONSTRAINT followup_adherence_range CHECK (adherence_pct IS NULL OR adherence_pct BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='plan_item_custom_kcal_nonneg') THEN
    ALTER TABLE plan_item ADD CONSTRAINT plan_item_custom_kcal_nonneg CHECK (custom_kcal IS NULL OR custom_kcal >= 0);
  END IF;
END $$;

-- Preserve UNKNOWN calories-from-macros semantics for upgraded databases.
ALTER TABLE nutrition_serving DROP COLUMN IF EXISTS kcal_from_macros;
ALTER TABLE nutrition_serving ADD COLUMN kcal_from_macros NUMERIC(8,2) GENERATED ALWAYS AS
  (CASE WHEN protein_g IS NULL OR carb_g IS NULL OR fat_g IS NULL THEN NULL
        ELSE protein_g*4 + carb_g*4 + fat_g*9 END) STORED;
CREATE INDEX IF NOT EXISTS idx_followup_weight ON followup (client_id, visit_date DESC, weight_kg);

CREATE OR REPLACE VIEW v_optimizer_eligible AS
SELECT f.id, f.canonical_id, f.name_ar, f.name_en, f.category, f.entity_type, f.food_role,
       s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g,
       e.tier AS evidence_tier, s.status
FROM food_item f
JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id
WHERE f.is_active
  AND s.kcal IS NOT NULL
  AND s.status='COMPUTABLE'
  AND e.tier IN ('high','verified','calculated');

CREATE OR REPLACE VIEW food_item_full AS
SELECT f.*, s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g, s.status,
       e.tier AS evidence_tier, e.confidence, e.source_ref, e.verified_by, e.verified_at
FROM food_item f
LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id;

COMMIT;
