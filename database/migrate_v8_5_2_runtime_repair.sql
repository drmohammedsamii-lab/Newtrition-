-- Newtrition V8.5.2 — runtime repair migration.
--
-- Every change here fixes a defect that was proven at runtime against a live
-- PostgreSQL instance: the application code referenced these relations,
-- columns and functions, but no prior migration ever created them, so the
-- affected endpoints returned HTTP 500 on every call.
--
-- Proven-broken endpoints repaired by this file:
--   GET  /api/foods/:id/substitutes      42883  find_substitutes() missing
--   POST /api/clients/:id/plans          42703  plan.notes missing
--   POST /api/plans/:id/release          42703  plan.superseded_by missing
--   POST /api/clients/:id/account        42703  client_account.must_change_password missing
--   GET  /api/client/plan                42P01  v_client_visible_plan missing
--   GET  /api/client/logs                42P01  daily_log missing
--   POST /api/client/logs                42P01  daily_log missing
--   POST /api/client/checkin             42P01  meal_checkin missing
--   GET  /api/client/checkins            42P01  meal_checkin missing
--   GET  /api/clients/:id/logs           42P01  daily_log + v_adherence missing

BEGIN;

/* ---------- 1. plan.notes -------------------------------------------------
   The plan INSERT writes a notes column that the schema never defined, so
   saving any draft plan failed. This is the primary clinician workflow. */
ALTER TABLE plan ADD COLUMN IF NOT EXISTS notes TEXT;

/* ---------- 2. plan.superseded_by -----------------------------------------
   Releasing v3 is supposed to retire the plan the client was following.
   Without this column the release transaction aborts, so no plan could ever
   reach a client. */
ALTER TABLE plan ADD COLUMN IF NOT EXISTS superseded_by BIGINT
  REFERENCES plan(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_plan_active_release
  ON plan(client_id, version DESC)
  WHERE is_released AND superseded_by IS NULL;

/* ---------- 3. client_account.must_change_password ------------------------
   The clinician issues a temporary password and the client must replace it on
   first login. The column was referenced in six places but never created, so
   both account creation and client login failed. */
ALTER TABLE client_account ADD COLUMN IF NOT EXISTS must_change_password
  BOOLEAN NOT NULL DEFAULT FALSE;

/* ---------- 4. daily_log --------------------------------------------------
   One row per client per day. The ON CONFLICT upsert in the API requires the
   (client_id, log_date) unique constraint to exist. */
CREATE TABLE IF NOT EXISTS daily_log (
  id         BIGSERIAL PRIMARY KEY,
  client_id  BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  log_date   DATE   NOT NULL,
  weight_kg  NUMERIC(6,2) CHECK (weight_kg IS NULL OR weight_kg > 0),
  water_ml   INTEGER      CHECK (water_ml  IS NULL OR water_ml  >= 0),
  steps      INTEGER      CHECK (steps     IS NULL OR steps     >= 0),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT daily_log_client_date_key UNIQUE (client_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_log_client_date
  ON daily_log(client_id, log_date DESC);

/* ---------- 5. meal_checkin -----------------------------------------------
   Per-plan-item adherence. Cascades from plan_item so deleting a plan does
   not orphan adherence rows. */
CREATE TABLE IF NOT EXISTS meal_checkin (
  id           BIGSERIAL PRIMARY KEY,
  client_id    BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  plan_item_id BIGINT NOT NULL REFERENCES plan_item(id) ON DELETE CASCADE,
  log_date     DATE   NOT NULL,
  eaten        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meal_checkin_unique_key UNIQUE (client_id, plan_item_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_meal_checkin_client_date
  ON meal_checkin(client_id, log_date DESC);

/* ---------- 6. v_client_visible_plan --------------------------------------
   The single source of truth for "what may this client see".
   A plan is visible only when it is RELEASED, APPROVED, and not superseded.
   The client portal and the check-in ownership guard both depend on it, so
   this view is a clinical safety boundary, not a convenience. */
CREATE OR REPLACE VIEW v_client_visible_plan AS
SELECT p.id            AS plan_id,
       p.client_id,
       p.version,
       p.label,
       p.notes,
       p.target_kcal,
       p.target_protein_g,
       p.target_carb_g,
       p.target_fat_g,
       p.target_fiber_g,
       p.approved_by,
       p.approved_at,
       p.quality_status,
       p.created_at
FROM plan p
WHERE p.is_released = TRUE
  AND p.superseded_by IS NULL
  AND p.workflow_status = 'APPROVED';

/* ---------- 7. v_adherence ------------------------------------------------
   Aggregates meal_checkin into the per-day shape the clinician log endpoint
   joins against: how many items were logged, and how many were eaten. */
CREATE OR REPLACE VIEW v_adherence AS
SELECT mc.client_id,
       mc.log_date,
       count(*) FILTER (WHERE mc.eaten)::int AS eaten,
       count(*)::int                          AS logged,
       CASE WHEN count(*) = 0 THEN NULL
            ELSE round(100.0 * count(*) FILTER (WHERE mc.eaten) / count(*), 1)
       END AS adherence_pct
FROM meal_checkin mc
GROUP BY mc.client_id, mc.log_date;

/* ---------- 8. find_substitutes() -----------------------------------------
   server.js calls find_substitutes($1,$2); the engine was only ever created as
   find_substitutes_v31(). The substitution button in every meal row therefore
   threw 42883 on every click. This is a thin delegating wrapper so there is
   exactly one implementation of the scoring logic. */
CREATE OR REPLACE FUNCTION find_substitutes(p_canonical_id TEXT, p_limit INT DEFAULT 12)
RETURNS TABLE (
  canonical_id  TEXT,
  name_ar       TEXT,
  name_en       TEXT,
  food_role     food_role,
  category      TEXT,
  kcal          NUMERIC,
  protein_g     NUMERIC,
  carb_g        NUMERIC,
  fat_g         NUMERIC,
  evidence_tier evidence_tier,
  distance      NUMERIC
) AS $$
BEGIN
  RETURN QUERY SELECT * FROM find_substitutes_v31(p_canonical_id, p_limit);
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
