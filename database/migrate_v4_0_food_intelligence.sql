-- Newtrition V4.0 — Food Intelligence foundation.
-- Additive migration: keeps all existing data and introduces structured
-- ingredients, allergens, portions, and explicit client constraints.

CREATE TABLE IF NOT EXISTS food_ingredient (
  food_item_id BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
  ingredient_name TEXT NOT NULL,
  is_major BOOLEAN NOT NULL DEFAULT TRUE,
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (food_item_id, ingredient_name)
);
CREATE INDEX IF NOT EXISTS idx_food_ingredient_name ON food_ingredient (lower(ingredient_name));
CREATE INDEX IF NOT EXISTS idx_food_ingredient_food ON food_ingredient (food_item_id);

CREATE TABLE IF NOT EXISTS portion_option (
  id BIGSERIAL PRIMARY KEY,
  food_item_id BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  grams NUMERIC(8,2),
  ml NUMERIC(8,2),
  unit_count NUMERIC(8,2),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (grams IS NULL OR grams > 0),
  CHECK (ml IS NULL OR ml > 0),
  CHECK (unit_count IS NULL OR unit_count > 0),
  CHECK ((grams IS NOT NULL)::int + (ml IS NOT NULL)::int + (unit_count IS NOT NULL)::int >= 1)
);
CREATE INDEX IF NOT EXISTS idx_portion_option_food ON portion_option(food_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portion_default_one ON portion_option(food_item_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS client_constraint (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  constraint_key TEXT NOT NULL,
  value TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'HARD',
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('diet','allergen','medical','cultural','meal','macro','preference')),
  CHECK (severity IN ('HARD','SOFT','INFO')),
  UNIQUE (client_id, kind, constraint_key, value)
);
CREATE INDEX IF NOT EXISTS idx_client_constraint_client ON client_constraint(client_id, kind);

-- Structured catalog view. This does not invent missing data; it reports coverage.
CREATE OR REPLACE VIEW v_food_intelligence AS
SELECT
  f.id, f.canonical_id, f.name_ar, f.name_en, f.entity_type, f.food_role,
  f.category, f.source, f.brand, f.portion_label, f.portion_grams, f.is_active,
  s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g, s.status,
  e.tier AS evidence_tier, e.confidence, e.source_ref, e.verified_by, e.verified_at,
  (SELECT count(*)::int FROM food_ingredient fi WHERE fi.food_item_id=f.id) AS ingredient_count,
  (SELECT count(*)::int FROM food_allergen fa WHERE fa.food_item_id=f.id) AS allergen_count,
  (SELECT count(*)::int FROM portion_option po WHERE po.food_item_id=f.id) AS portion_option_count,
  CASE
    WHEN f.portion_grams IS NOT NULL OR EXISTS (SELECT 1 FROM portion_option po WHERE po.food_item_id=f.id)
      THEN 'COVERED' ELSE 'MISSING'
  END AS portion_coverage,
  CASE
    WHEN EXISTS (SELECT 1 FROM food_ingredient fi WHERE fi.food_item_id=f.id)
      THEN 'STRUCTURED' ELSE 'UNSTRUCTURED'
  END AS ingredient_coverage,
  CASE
    WHEN EXISTS (SELECT 1 FROM food_allergen fa WHERE fa.food_item_id=f.id)
      THEN 'STRUCTURED' ELSE 'UNKNOWN'
  END AS allergen_coverage
FROM food_item f
LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id;

-- Explicitly document which quality views are safe for automatic planning.
CREATE OR REPLACE VIEW v_optimizer_eligible_strict AS
SELECT * FROM v_food_quality
WHERE quality_class='AUTO_ELIGIBLE'
  AND NOT EXISTS (
    SELECT 1 FROM food_allergen fa
    WHERE fa.food_item_id=v_food_quality.id
      AND lower(fa.allergen) IN ('unknown','unspecified')
  );
