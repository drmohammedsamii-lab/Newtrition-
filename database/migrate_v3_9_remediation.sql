-- Newtrition V3.9 — remediation planning layer.
-- Does not auto-write nutrition values. It stores review workflow metadata only.

ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS remediation_action TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS remediation_note TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS remediation_priority TEXT;
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS remediation_rank NUMERIC(10,2);
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS remediation_generated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_review_queue_remediation_rank
  ON review_queue(status, remediation_rank DESC NULLS LAST, created_at ASC);

CREATE OR REPLACE VIEW v_review_remediation_v39 AS
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
  rq.remediation_action,
  rq.remediation_note,
  rq.remediation_priority,
  rq.remediation_rank,
  rq.remediation_generated_at,
  f.canonical_id,
  f.name_ar,
  f.name_en,
  f.brand,
  f.category,
  f.entity_type,
  f.food_role,
  f.source,
  s.kcal,
  s.protein_g,
  s.carb_g,
  s.fat_g,
  s.fiber_g,
  s.status AS nutrition_status,
  e.tier AS evidence_tier
FROM review_queue rq
JOIN food_item f ON f.id=rq.food_item_id
LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id;
