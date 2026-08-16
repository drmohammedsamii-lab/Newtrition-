-- Newtrition V3.7 — evidence/data-quality lanes.
-- Keeps the raw catalog intact; adds auditable quality views only.

CREATE OR REPLACE VIEW v_food_quality AS
SELECT
  f.id,
  f.canonical_id,
  f.name_ar,
  f.name_en,
  f.category,
  f.entity_type,
  f.food_role,
  f.source,
  f.brand,
  f.portion_label,
  f.portion_grams,
  f.is_active,
  s.kcal,
  s.protein_g,
  s.carb_g,
  s.fat_g,
  s.fiber_g,
  s.status,
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
  END AS quality_reasons
FROM food_item f
LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id;

CREATE OR REPLACE VIEW v_optimizer_eligible_strict AS
SELECT * FROM v_food_quality
WHERE quality_class = 'AUTO_ELIGIBLE';

CREATE OR REPLACE VIEW v_optimizer_eligible_with_warning AS
SELECT * FROM v_food_quality
WHERE quality_class IN ('AUTO_ELIGIBLE','AUTO_WITH_WARNING');

CREATE INDEX IF NOT EXISTS idx_food_allergen_food ON food_allergen(food_item_id);
