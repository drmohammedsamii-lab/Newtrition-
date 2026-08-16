-- Newtrition V8.4 hardening. Non-destructive: never deletes food records.

-- 1) Food deletion guard: foods are preserved; deactivate/block instead of DELETE.
CREATE OR REPLACE FUNCTION prevent_food_item_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FOOD_DELETE_BLOCKED: food_item records are immutable; use is_active/status instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_food_item_delete ON food_item;
CREATE TRIGGER trg_prevent_food_item_delete
  BEFORE DELETE ON food_item FOR EACH ROW EXECUTE FUNCTION prevent_food_item_delete();

-- 2) Nutrition defaults/data integrity. NULL remains UNKNOWN; COMPUTABLE requires core macros.
ALTER TABLE nutrition_serving ALTER COLUMN status SET DEFAULT 'INCOMPLETE';

-- Use a dependency-safe view for the nullable derived calorie calculation. We intentionally
-- do not drop/recreate the legacy generated column because older views may depend on it.
CREATE OR REPLACE VIEW v_nutrition_integrity AS
SELECT ns.food_item_id, ns.kcal, ns.protein_g, ns.carb_g, ns.fat_g, ns.fiber_g, ns.status,
       CASE WHEN ns.protein_g IS NULL OR ns.carb_g IS NULL OR ns.fat_g IS NULL
            THEN NULL
            ELSE ns.protein_g*4 + ns.carb_g*4 + ns.fat_g*9 END AS kcal_from_macros_safe
FROM nutrition_serving ns;

-- Normalize existing incomplete rows without deleting anything.
UPDATE nutrition_serving
SET status='INCOMPLETE'
WHERE kcal IS NULL OR protein_g IS NULL OR carb_g IS NULL OR fat_g IS NULL;

-- 3) Prevent an incomplete row being labeled COMPUTABLE via accidental/manual SQL.
DO $$ BEGIN
  ALTER TABLE nutrition_serving ADD CONSTRAINT nutrition_computable_core_chk
    CHECK (status <> 'COMPUTABLE' OR (kcal IS NOT NULL AND protein_g IS NOT NULL AND carb_g IS NOT NULL AND fat_g IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) Preserve clinician allergen evidence; lower-confidence automation must not overwrite it.
DO $$ BEGIN
  ALTER TABLE food_allergen ADD CONSTRAINT food_allergen_allowed_confidence_chk
    CHECK (confidence IN ('explicit_label','name_keyword','inferred_pattern','clinician_added','verified_source'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5) Tenant backfill: ensure legacy clinicians have an organization without deleting anything.
CREATE TABLE IF NOT EXISTS organization (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE clinician ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organization(id) ON DELETE SET NULL;
DO $$ DECLARE org_id BIGINT;
BEGIN
  SELECT id INTO org_id FROM organization WHERE slug='legacy-default' LIMIT 1;
  IF org_id IS NULL THEN
    INSERT INTO organization(name,slug) VALUES('Legacy Default Organization','legacy-default') RETURNING id INTO org_id;
  END IF;
  UPDATE clinician SET organization_id=org_id WHERE organization_id IS NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_clinician_org ON clinician(organization_id);

-- 6) Plan workflow indexes.
CREATE INDEX IF NOT EXISTS idx_plan_workflow_quality ON plan(client_id, workflow_status, quality_status, version DESC);

-- 7) Dynamic food data coverage view; no hard-coded counts.
CREATE OR REPLACE VIEW v_food_data_coverage AS
SELECT
  COUNT(*)::int AS total_foods,
  COUNT(*) FILTER (WHERE f.allergen_profile_status='VERIFIED')::int AS allergen_verified,
  COUNT(*) FILTER (WHERE f.allergen_profile_status='INFERRED_PENDING_REVIEW')::int AS allergen_pending,
  COUNT(*) FILTER (WHERE f.allergen_profile_status='UNKNOWN')::int AS allergen_unknown,
  COUNT(*) FILTER (WHERE f.food_role='UNKNOWN')::int AS food_role_unknown,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM food_ingredient fi WHERE fi.food_item_id=f.id))::int AS foods_with_ingredients,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM portion_option po WHERE po.food_item_id=f.id))::int AS foods_with_portions,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM food_diet_tag dt WHERE dt.food_item_id=f.id))::int AS foods_with_diet_tags
FROM food_item f;

-- 8) Custom plan-item nutrition must use the same core-data integrity gate.
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS custom_protein_g NUMERIC(7,2);
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS custom_carb_g NUMERIC(7,2);
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS custom_fat_g NUMERIC(7,2);
ALTER TABLE plan_item ADD COLUMN IF NOT EXISTS custom_fiber_g NUMERIC(7,2);
DO $$ BEGIN
  ALTER TABLE plan_item ADD CONSTRAINT plan_item_food_or_custom_chk
    CHECK (food_item_id IS NOT NULL OR custom_name IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE plan_item ADD CONSTRAINT plan_item_custom_core_chk
    CHECK (food_item_id IS NOT NULL OR (custom_kcal IS NOT NULL AND custom_protein_g IS NOT NULL AND custom_carb_g IS NOT NULL AND custom_fat_g IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 9) Plan timestamps used by the hardened workflow/API.
ALTER TABLE plan ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE plan SET updated_at=coalesce(updated_at, created_at);
