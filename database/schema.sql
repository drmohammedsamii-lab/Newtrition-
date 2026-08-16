-- ============================================================
-- Newtrition — Canonical Nutrition Database Schema (Postgres)
-- Phase 2 deliverable. Derived from V11.9.1 runtime catalog.
-- ============================================================

-- ---------- Reference / enum-like lookups ----------

CREATE TYPE entity_type      AS ENUM ('FOOD', 'PRODUCT', 'MEAL', 'RECIPE');
CREATE TYPE evidence_tier    AS ENUM ('high', 'verified', 'calculated', 'estimated', 'unknown');
CREATE TYPE nutrition_status AS ENUM ('COMPUTABLE', 'INCOMPLETE', 'CONFLICT_REVIEW', 'CORRECTED_PENDING_SIGNOFF');
CREATE TYPE food_role AS ENUM ('PROTEIN','STARCH','DAIRY','FRUIT','VEGETABLE','LEGUME','FAT_NUT','BEVERAGE','SWEET','BAR_SUPP','COMPOSITE_MEAL','UNKNOWN');
CREATE TYPE review_status    AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_SOURCE');

-- ---------- Core catalog ----------

CREATE TABLE food_item (
    id                BIGSERIAL PRIMARY KEY,
    canonical_id      TEXT UNIQUE NOT NULL,          -- CAN-###   stable public key
    source_id         TEXT,                          -- LEGACY-### / U#####  provenance
    name_ar           TEXT NOT NULL,
    name_en           TEXT,
    entity_type       entity_type NOT NULL,
    food_role         food_role NOT NULL DEFAULT 'UNKNOWN',
    category          TEXT,                          -- فطار / رئيسية / سناك ...
    source            TEXT,                          -- بيتي / دليفري / brand channel
    brand             TEXT,
    portion_label     TEXT,                          -- "1 بيضة (~50جم)"
    portion_grams     NUMERIC(8,2),                  -- parsed where possible, NULL otherwise
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_food_item_name_ar   ON food_item USING gin (to_tsvector('simple', name_ar));
CREATE INDEX idx_food_item_name_en   ON food_item USING gin (to_tsvector('simple', coalesce(name_en,'')));
CREATE INDEX idx_food_item_category  ON food_item (category);
CREATE INDEX idx_food_item_entity    ON food_item (entity_type);
CREATE INDEX idx_food_item_role      ON food_item (food_role);
CREATE INDEX idx_food_item_brand     ON food_item (brand);

-- ---------- Nutrition: per-serving and per-100g kept separate ----------
-- NULL means "unknown", never 0. This distinction is clinically load-bearing.

CREATE TABLE nutrition_serving (
    food_item_id  BIGINT PRIMARY KEY REFERENCES food_item(id) ON DELETE CASCADE,
    kcal          NUMERIC(8,2),
    protein_g     NUMERIC(7,2),
    carb_g        NUMERIC(7,2),
    fat_g         NUMERIC(7,2),
    fiber_g       NUMERIC(7,2),
    status        nutrition_status NOT NULL DEFAULT 'INCOMPLETE',
    kcal_from_macros NUMERIC(8,2) GENERATED ALWAYS AS
        (CASE WHEN protein_g IS NULL OR carb_g IS NULL OR fat_g IS NULL
              THEN NULL
              ELSE protein_g*4 + carb_g*4 + fat_g*9
         END) STORED,
    CONSTRAINT nonneg_serving CHECK (
        coalesce(kcal,0)      >= 0 AND coalesce(protein_g,0) >= 0 AND
        coalesce(carb_g,0)    >= 0 AND coalesce(fat_g,0)     >= 0 AND
        coalesce(fiber_g,0)   >= 0
    )
);

CREATE TABLE nutrition_per100 (
    food_item_id  BIGINT PRIMARY KEY REFERENCES food_item(id) ON DELETE CASCADE,
    kcal          NUMERIC(8,2),
    protein_g     NUMERIC(7,2),
    carb_g        NUMERIC(7,2),
    fat_g         NUMERIC(7,2),
    fiber_g       NUMERIC(7,2)
);

-- Original values before any automated correction. Nothing is ever overwritten
-- without the pre-correction figures being retained here.
CREATE TABLE nutrition_original (
    food_item_id    BIGINT PRIMARY KEY REFERENCES food_item(id) ON DELETE CASCADE,
    kcal            NUMERIC(8,2),
    protein_g       NUMERIC(7,2),
    carb_g          NUMERIC(7,2),
    fat_g           NUMERIC(7,2),
    correction_rule TEXT,
    rationale       TEXT,
    corrected_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Evidence & clinical review (human-in-the-loop) ----------

CREATE TABLE evidence (
    food_item_id  BIGINT PRIMARY KEY REFERENCES food_item(id) ON DELETE CASCADE,
    tier          evidence_tier NOT NULL DEFAULT 'unknown',
    confidence    TEXT,
    source_ref    TEXT,          -- NNI 2006 page, USDA id, manufacturer label, ...
    verified_by   TEXT,          -- clinician name/id — required before APPROVED
    verified_at   TIMESTAMPTZ
);

CREATE TABLE review_queue (
    id            BIGSERIAL PRIMARY KEY,
    food_item_id  BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
    reason        TEXT NOT NULL,           -- 'CALORIE_MACRO_CONFLICT', 'INCOMPLETE_MACROS', ...
    detail        TEXT,
    status        review_status NOT NULL DEFAULT 'PENDING',
    resolved_by   TEXT,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_queue_status ON review_queue (status, reason);

-- ---------- Clinician / client / plan layer ----------

CREATE TABLE clinician (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    full_name     TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE client (
    id            BIGSERIAL PRIMARY KEY,
    clinician_id  BIGINT NOT NULL REFERENCES clinician(id) ON DELETE CASCADE,
    full_name     TEXT NOT NULL,
    gender        TEXT,
    birth_year    INT,
    height_cm     NUMERIC(5,1),
    goal          TEXT,
    -- assessment fields carried over from V11
    conditions    TEXT,
    medications   TEXT,
    gi_notes      TEXT,
    habits        TEXT,
    sleep         TEXT,
    stress        TEXT,
    ramadan_mode  BOOLEAN DEFAULT FALSE,
    carb_cycling  BOOLEAN DEFAULT FALSE,
    diet_pattern  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_client_clinician ON client (clinician_id);

CREATE TABLE client_exclusion (
    id         BIGSERIAL PRIMARY KEY,
    client_id  BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    term       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'preference',
    CHECK (kind IN ('allergy','medical','religious','dislike','preference'))
);

CREATE INDEX idx_client_exclusion_client ON client_exclusion (client_id);

-- Structured allergen tags. Seed as data becomes available; name matching remains
-- a fallback only and is never treated as a complete allergy model.
CREATE TABLE food_allergen (
    food_item_id BIGINT NOT NULL REFERENCES food_item(id) ON DELETE CASCADE,
    allergen     TEXT NOT NULL,
    PRIMARY KEY (food_item_id, allergen)
);
CREATE INDEX idx_food_allergen_allergen ON food_allergen (allergen);

CREATE TABLE plan (
    id            BIGSERIAL PRIMARY KEY,
    client_id     BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    version       INT NOT NULL DEFAULT 1,
    label         TEXT,
    target_kcal   NUMERIC(8,2),
    target_protein_g NUMERIC(7,2),
    target_carb_g NUMERIC(7,2),
    target_fat_g  NUMERIC(7,2),
    target_fiber_g NUMERIC(7,2),
    -- clinical gate: a plan is not client-visible until a clinician signs it
    approved_by   TEXT,
    approved_at   TIMESTAMPTZ,
    is_released   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, version)
);

CREATE TABLE plan_day (
    id         BIGSERIAL PRIMARY KEY,
    plan_id    BIGINT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    day_index  INT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
    day_name   TEXT,
    day_type   TEXT,                 -- low / medium / high carb
    UNIQUE (plan_id, day_index)      -- structurally prevents the duplicate-day bug
);

CREATE TABLE plan_item (
    id            BIGSERIAL PRIMARY KEY,
    plan_day_id   BIGINT NOT NULL REFERENCES plan_day(id) ON DELETE CASCADE,
    food_item_id  BIGINT REFERENCES food_item(id),
    slot          TEXT NOT NULL,             -- فطار / سناك ١ / غداء ...
    qty           NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
    is_locked     BOOLEAN NOT NULL DEFAULT FALSE,
    custom_name   TEXT,                      -- for ad-hoc items with no catalog row
    custom_kcal   NUMERIC(8,2),
    substituted_from BIGINT REFERENCES food_item(id),
    substitution_method TEXT,
    position      INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_plan_item_day ON plan_item (plan_day_id);

-- ---------- Follow-up ----------

CREATE TABLE followup (
    id            BIGSERIAL PRIMARY KEY,
    client_id     BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    visit_date    DATE NOT NULL,
    weight_kg     NUMERIC(5,2),
    waist_cm      NUMERIC(5,1),
    body_fat_pct  NUMERIC(4,1),
    adherence_pct NUMERIC(5,2),
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_followup_client_date ON followup (client_id, visit_date DESC);
CREATE INDEX idx_followup_weight ON followup (client_id, visit_date DESC, weight_kg);

-- ---------- Convenience view: what is safe to auto-suggest ----------
-- Mirrors the V11 "eligible" filter, but makes the rule explicit and auditable.

CREATE VIEW v_optimizer_eligible AS
SELECT f.id, f.canonical_id, f.name_ar, f.name_en, f.category, f.entity_type, f.food_role,
       s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g,
       e.tier AS evidence_tier, s.status
FROM food_item f
JOIN nutrition_serving s ON s.food_item_id = f.id
LEFT JOIN evidence e     ON e.food_item_id = f.id
WHERE f.is_active
  AND s.kcal IS NOT NULL
  AND s.status = 'COMPUTABLE'
  AND e.tier IN ('high','verified','calculated');

-- ---------- v3.1 integrity hardening ----------
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

-- Full catalog view for privileged review/search. It is intentionally broader than
-- v_optimizer_eligible and therefore must remain role-gated at the API layer.
CREATE OR REPLACE VIEW food_item_full AS
SELECT f.*, s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g, s.status,
       e.tier AS evidence_tier, e.confidence, e.source_ref, e.verified_by, e.verified_at
FROM food_item f
LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
LEFT JOIN evidence e ON e.food_item_id=f.id;
