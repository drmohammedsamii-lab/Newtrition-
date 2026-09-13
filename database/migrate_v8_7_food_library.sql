-- V8.7 — Food Intelligence Library (read-only reference layer from Master Workbook v12)
-- Additive only. Does NOT touch food_item / nutrition_serving or any existing table.
-- Two-layer architecture: food_item (SaaS meals/composite entries) stays authoritative for plans;
-- this library is a separate, larger atomic-food reference layer, linked (not merged) via food_item_library_link.

CREATE TABLE IF NOT EXISTS food_library_canonical (
    canonical_id      TEXT PRIMARY KEY,        -- CANON-#####
    name_en           TEXT,
    name_ar           TEXT,
    category_broad    TEXT,
    category_detailed TEXT,
    subcategory       TEXT
);

CREATE TABLE IF NOT EXISTS food_library_variant (
    product_id        TEXT PRIMARY KEY,        -- PROD-#####
    canonical_id      TEXT NOT NULL REFERENCES food_library_canonical(canonical_id),
    catalog_id        TEXT UNIQUE NOT NULL,     -- FC-##### (join key to nutrition/readiness)
    brand             TEXT,
    product_name_en   TEXT,
    product_name_ar   TEXT,
    pack_size_or_serving TEXT,
    platform          TEXT
);

CREATE TABLE IF NOT EXISTS food_library_nutrition (
    catalog_id        TEXT PRIMARY KEY REFERENCES food_library_variant(catalog_id),
    calories_kcal     NUMERIC(8,2),
    calories_grade    TEXT,
    protein_g         NUMERIC(7,2),
    protein_grade     TEXT,
    carbs_g           NUMERIC(7,2),
    carbs_grade       TEXT,
    fat_g             NUMERIC(7,2),
    fat_grade         TEXT,
    fiber_g           NUMERIC(7,2),
    fiber_grade       TEXT,
    sodium_mg         NUMERIC(8,2),
    sodium_grade      TEXT
);

CREATE TABLE IF NOT EXISTS food_library_readiness (
    catalog_id        TEXT PRIMARY KEY REFERENCES food_library_variant(catalog_id),
    readiness_score   NUMERIC(6,2),
    band              TEXT   -- RESEARCH_ONLY / HOLD / REVIEW_REQUIRED / VERIFIED_APPROVED
);

-- Link table: maps existing SaaS food_item rows to library entries.
-- Populated later via a reviewed name-matching pass — NOT auto-authoritative.
CREATE TABLE IF NOT EXISTS food_item_library_link (
    food_item_id      BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
    canonical_id      TEXT NOT NULL REFERENCES food_library_canonical(canonical_id),
    match_method      TEXT NOT NULL,   -- 'exact_name' / 'manual' / 'fuzzy_pending_review'
    match_confidence  NUMERIC(4,3),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (food_item_id, canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_flc_category ON food_library_canonical (category_broad);
CREATE INDEX IF NOT EXISTS idx_flv_canonical ON food_library_variant (canonical_id);
CREATE INDEX IF NOT EXISTS idx_flc_name_ar ON food_library_canonical USING gin (to_tsvector('simple', coalesce(name_ar,'')));
