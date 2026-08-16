-- Newtrition V3.8 — evidence review workflow hardening
-- Safe to run after V3.7 quality migration.

ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 20;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS quality_class TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS suggested_action TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS review_notes TEXT;
CREATE INDEX IF NOT EXISTS idx_review_queue_priority ON review_queue(status, priority DESC, created_at ASC);

CREATE OR REPLACE VIEW v_review_queue_v38 AS
SELECT
  rq.id,
  rq.status,
  rq.reason,
  rq.detail,
  rq.priority,
  rq.quality_class,
  rq.suggested_action,
  rq.source_ref,
  rq.review_notes,
  rq.resolved_by,
  rq.resolved_at,
  rq.created_at,
  f.canonical_id,
  f.name_ar,
  f.name_en,
  f.brand,
  f.category,
  f.food_role,
  v.kcal,
  v.protein_g,
  v.carb_g,
  v.fat_g,
  v.fiber_g,
  v.status AS nutrition_status,
  v.evidence_tier,
  v.quality_class AS live_quality_class,
  v.quality_reasons
FROM review_queue rq
JOIN food_item f ON f.id = rq.food_item_id
LEFT JOIN v_food_quality v ON v.id = f.id;

-- Backfill unresolved quality records into the review queue without duplicating entries.
INSERT INTO review_queue (food_item_id, reason, detail, status, priority, quality_class, suggested_action)
SELECT
  v.id,
  CASE
    WHEN v.status = 'CONFLICT_REVIEW' THEN 'CALORIE_MACRO_CONFLICT'
    WHEN v.kcal IS NULL OR v.protein_g IS NULL OR v.carb_g IS NULL OR v.fat_g IS NULL THEN 'INCOMPLETE_MACROS'
    WHEN v.status <> 'COMPUTABLE' THEN 'STATUS_REVIEW'
    WHEN coalesce(v.evidence_tier,'unknown') IN ('estimated','unknown') THEN 'EVIDENCE_REVIEW'
    WHEN v.evidence_tier = 'calculated' THEN 'CALCULATED_SIGNOFF'
    WHEN v.fiber_g IS NULL THEN 'INCOMPLETE_FIBER'
    ELSE 'GENERAL_REVIEW'
  END,
  array_to_string(v.quality_reasons, ', '),
  'PENDING',
  CASE
    WHEN v.status = 'CONFLICT_REVIEW' THEN 100
    WHEN v.kcal IS NULL OR v.protein_g IS NULL OR v.carb_g IS NULL OR v.fat_g IS NULL THEN 95
    WHEN v.status <> 'COMPUTABLE' THEN 90
    WHEN coalesce(v.evidence_tier,'unknown') IN ('estimated','unknown') THEN 75
    WHEN v.evidence_tier = 'calculated' THEN 45
    WHEN v.fiber_g IS NULL THEN 30
    ELSE 20
  END,
  v.quality_class,
  CASE
    WHEN v.status = 'CONFLICT_REVIEW' THEN 'Resolve calorie/macro conflict and confirm source.'
    WHEN v.kcal IS NULL OR v.protein_g IS NULL OR v.carb_g IS NULL OR v.fat_g IS NULL THEN 'Fill missing kcal/protein/carbs/fat values from a trusted source.'
    WHEN v.status <> 'COMPUTABLE' THEN 'Review nutrition status and evidence before release.'
    WHEN coalesce(v.evidence_tier,'unknown') IN ('estimated','unknown') THEN 'Replace estimated/unknown evidence or explicitly verify the current values.'
    WHEN v.evidence_tier = 'calculated' THEN 'Clinician sign-off on calculated values.'
    WHEN v.fiber_g IS NULL THEN 'Add fiber when available; otherwise keep as warning lane.'
    ELSE 'Review record and confirm suitability.'
  END
FROM v_food_quality v
WHERE v.quality_class = 'REVIEW_REQUIRED'
  AND NOT EXISTS (
    SELECT 1 FROM review_queue rq WHERE rq.food_item_id = v.id AND rq.status = 'PENDING'
  );

UPDATE review_queue rq
SET reason = CASE
      WHEN v.status = 'CONFLICT_REVIEW' THEN 'CALORIE_MACRO_CONFLICT'
      WHEN v.kcal IS NULL OR v.protein_g IS NULL OR v.carb_g IS NULL OR v.fat_g IS NULL THEN 'INCOMPLETE_MACROS'
      WHEN v.status <> 'COMPUTABLE' THEN 'STATUS_REVIEW'
      WHEN coalesce(v.evidence_tier,'unknown') IN ('estimated','unknown') THEN 'EVIDENCE_REVIEW'
      WHEN v.evidence_tier = 'calculated' THEN 'CALCULATED_SIGNOFF'
      WHEN v.fiber_g IS NULL THEN 'INCOMPLETE_FIBER'
      ELSE 'GENERAL_REVIEW'
    END,
    quality_class = v.quality_class,
    suggested_action = CASE
      WHEN v.status = 'CONFLICT_REVIEW' THEN 'Resolve calorie/macro conflict and confirm source.'
      WHEN v.kcal IS NULL OR v.protein_g IS NULL OR v.carb_g IS NULL OR v.fat_g IS NULL THEN 'Fill missing kcal/protein/carbs/fat values from a trusted source.'
      WHEN v.status <> 'COMPUTABLE' THEN 'Review nutrition status and evidence before release.'
      WHEN coalesce(v.evidence_tier,'unknown') IN ('estimated','unknown') THEN 'Replace estimated/unknown evidence or explicitly verify the current values.'
      WHEN v.evidence_tier = 'calculated' THEN 'Clinician sign-off on calculated values.'
      WHEN v.fiber_g IS NULL THEN 'Add fiber when available; otherwise keep as warning lane.'
      ELSE 'Review record and confirm suitability.'
    END,
    priority = CASE
      WHEN v.status = 'CONFLICT_REVIEW' THEN 100
      WHEN v.kcal IS NULL OR v.protein_g IS NULL OR v.carb_g IS NULL OR v.fat_g IS NULL THEN 95
      WHEN v.status <> 'COMPUTABLE' THEN 90
      WHEN coalesce(v.evidence_tier,'unknown') IN ('estimated','unknown') THEN 75
      WHEN v.evidence_tier = 'calculated' THEN 45
      WHEN v.fiber_g IS NULL THEN 30
      ELSE rq.priority
    END
FROM v_food_quality v
WHERE v.id = rq.food_item_id AND rq.status = 'PENDING';
