-- ============================================================
-- Newtrition — allergen safety fix.
--
-- The gap: a food can contain an allergen without saying so in its name
-- (e.g. "Chicken Alfredo Parmesan" contains dairy; nothing in the name
-- says milk/cheese/cream). A keyword-on-name scanner cannot catch this.
--
-- The fix has two parts:
--   1. An inference pipeline (populate_allergens.js) tags plausible
--      allergens using both direct keywords AND a curated list of
--      dish/sauce/preparation patterns that imply an allergen even when
--      the name doesn't say it.
--   2. This migration adds a profile-verification status SEPARATE from
--      "does this item have any allergen rows". That separation matters:
--      a food with a POSITIVE allergen tag is always excluded for a
--      matching constraint, verified or not — inference only ever adds
--      exclusions, never removes them. But treating an item as safe
--      because of an ABSENCE of a tag is only trustworthy once a
--      clinician has confirmed the tagging is complete for that item.
--      Without this distinction, a partially-tagged item (say, only its
--      gluten content was caught) would incorrectly pass a milk-allergy
--      check the moment it has ANY allergen row, which is more dangerous
--      than having zero rows (the existing fail-safe still catches
--      zero-row items).
-- ============================================================

DO $$ BEGIN
  CREATE TYPE allergen_profile_status AS ENUM ('UNKNOWN', 'INFERRED_PENDING_REVIEW', 'VERIFIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE food_item ADD COLUMN IF NOT EXISTS allergen_profile_status allergen_profile_status NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE food_item ADD COLUMN IF NOT EXISTS allergen_profile_reviewed_by TEXT;
ALTER TABLE food_item ADD COLUMN IF NOT EXISTS allergen_profile_reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_food_item_allergen_status ON food_item(allergen_profile_status);

-- Confidence/provenance on each tag, so a clinician reviewing can see
-- whether a tag came from an explicit name match or an inferred pattern.
ALTER TABLE food_allergen ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'inferred';
-- CHECK added separately (idempotent) since ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS
DO $$ BEGIN
  ALTER TABLE food_allergen ADD CONSTRAINT food_allergen_confidence_chk
    CHECK (confidence IN ('explicit_label','name_keyword','inferred_pattern','clinician_added'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- View used by the optimizer / candidate search now carries the
-- verification status alongside the allergen array, so the application
-- layer can apply the "positive tag always blocks, absence only trusted
-- once verified" rule described above.
CREATE OR REPLACE VIEW v_food_candidate_intelligence AS
SELECT
  f.id, f.canonical_id, f.name_ar, f.name_en, f.category, f.entity_type, f.food_role,
  f.source, f.brand, f.portion_label, f.portion_grams,
  s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g, s.status,
  e.tier AS evidence_tier,
  COALESCE((SELECT array_agg(fa.allergen ORDER BY fa.allergen) FROM food_allergen fa WHERE fa.food_item_id=f.id), ARRAY[]::text[]) AS allergens,
  COALESCE((SELECT array_agg(fi.ingredient_name ORDER BY fi.ingredient_name) FROM food_ingredient fi WHERE fi.food_item_id=f.id), ARRAY[]::text[]) AS ingredients,
  COALESCE((SELECT array_agg(po.label ORDER BY po.is_default DESC, po.id) FROM portion_option po WHERE po.food_item_id=f.id), ARRAY[]::text[]) AS portion_options,
  COALESCE((SELECT array_agg(dt.tag ORDER BY dt.tag) FROM food_diet_tag dt WHERE dt.food_item_id=f.id), ARRAY[]::text[]) AS diet_tags,
  f.allergen_profile_status
FROM food_item f
JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id
WHERE f.is_active;

-- Same addition to v_food_quality's dependents used by the optimizer.
CREATE OR REPLACE VIEW v_food_quality AS
SELECT
  f.id, f.canonical_id, f.name_ar, f.name_en, f.category, f.entity_type, f.food_role,
  f.source, f.brand, f.portion_label, f.portion_grams, f.is_active,
  s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g, s.status,
  e.tier AS evidence_tier,
  CASE
    WHEN NOT f.is_active THEN 'BLOCKED'
    WHEN s.status <> 'COMPUTABLE' OR s.kcal IS NULL OR s.protein_g IS NULL OR s.carb_g IS NULL OR s.fat_g IS NULL
      THEN 'REVIEW_REQUIRED'
    WHEN coalesce(e.tier::text,'unknown') IN ('estimated','unknown')
      THEN 'REVIEW_REQUIRED'
    WHEN s.fiber_g IS NULL OR e.tier = 'calculated'
      THEN 'AUTO_WITH_WARNING'
    ELSE 'AUTO_ELIGIBLE'
  END AS quality_class,
  CASE
    WHEN NOT f.is_active THEN ARRAY['inactive']::text[]
    ELSE ARRAY_REMOVE(ARRAY[
      CASE WHEN s.status <> 'COMPUTABLE' THEN 'status:'||s.status::text END,
      CASE WHEN s.kcal IS NULL OR s.protein_g IS NULL OR s.carb_g IS NULL OR s.fat_g IS NULL THEN 'missing_core_macros' END,
      CASE WHEN coalesce(e.tier::text,'unknown') IN ('estimated','unknown') THEN 'evidence:'||coalesce(e.tier::text,'missing') END,
      CASE WHEN s.fiber_g IS NULL THEN 'missing_fiber' END,
      CASE WHEN e.tier = 'calculated' THEN 'evidence:calculated' END
    ], NULL)
  END AS quality_reasons,
  f.allergen_profile_status
FROM food_item f
LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id;

CREATE OR REPLACE VIEW v_optimizer_eligible_strict AS
SELECT * FROM v_food_quality WHERE quality_class = 'AUTO_ELIGIBLE';

CREATE OR REPLACE VIEW v_optimizer_eligible_with_warning AS
SELECT * FROM v_food_quality WHERE quality_class IN ('AUTO_ELIGIBLE','AUTO_WITH_WARNING');
