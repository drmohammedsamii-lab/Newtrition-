-- Newtrition V4.1 — enforce normalized clinical-constraint inputs and expose
-- structured candidate evidence for the server-side eligibility engine.

ALTER TABLE client_constraint
  ADD CONSTRAINT client_constraint_value_nonempty CHECK (length(btrim(value)) > 0);

CREATE INDEX IF NOT EXISTS idx_client_constraint_lookup
  ON client_constraint(client_id, kind, severity, constraint_key, value);

CREATE OR REPLACE VIEW v_food_candidate_intelligence AS
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
  s.kcal,
  s.protein_g,
  s.carb_g,
  s.fat_g,
  s.fiber_g,
  s.status,
  e.tier AS evidence_tier,
  COALESCE((SELECT array_agg(fa.allergen ORDER BY fa.allergen) FROM food_allergen fa WHERE fa.food_item_id=f.id), ARRAY[]::text[]) AS allergens,
  COALESCE((SELECT array_agg(fi.ingredient_name ORDER BY fi.ingredient_name) FROM food_ingredient fi WHERE fi.food_item_id=f.id), ARRAY[]::text[]) AS ingredients,
  COALESCE((SELECT array_agg(po.label ORDER BY po.is_default DESC, po.id) FROM portion_option po WHERE po.food_item_id=f.id), ARRAY[]::text[]) AS portion_options
FROM food_item f
JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id
WHERE f.is_active;


CREATE TABLE IF NOT EXISTS food_diet_tag (
  food_item_id BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (food_item_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_food_diet_tag_tag ON food_diet_tag(tag);
CREATE INDEX IF NOT EXISTS idx_food_diet_tag_food ON food_diet_tag(food_item_id);

-- FIX: this view is redefined below with a different column order.
-- CREATE OR REPLACE VIEW cannot reorder/rename existing columns, so drop first.
DROP VIEW IF EXISTS v_food_candidate_intelligence CASCADE;
CREATE VIEW v_food_candidate_intelligence AS
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
  s.kcal,
  s.protein_g,
  s.carb_g,
  s.fat_g,
  s.fiber_g,
  s.status,
  e.tier AS evidence_tier,
  COALESCE((SELECT array_agg(fa.allergen ORDER BY fa.allergen) FROM food_allergen fa WHERE fa.food_item_id=f.id), ARRAY[]::text[]) AS allergens,
  COALESCE((SELECT array_agg(fi.ingredient_name ORDER BY fi.ingredient_name) FROM food_ingredient fi WHERE fi.food_item_id=f.id), ARRAY[]::text[]) AS ingredients,
  COALESCE((SELECT array_agg(dt.tag ORDER BY dt.tag) FROM food_diet_tag dt WHERE dt.food_item_id=f.id), ARRAY[]::text[]) AS diet_tags,
  COALESCE((SELECT array_agg(po.label ORDER BY po.is_default DESC, po.id) FROM portion_option po WHERE po.food_item_id=f.id), ARRAY[]::text[]) AS portion_options
FROM food_item f
JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id
WHERE f.is_active;
