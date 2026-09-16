-- V8.9 — per-clinician "recently used food" tracking, for fast re-selection
-- in the meal picker (matches the MyFitnessPal/FitXpert "Recently logged" pattern).
CREATE TABLE IF NOT EXISTS recent_food_use (
    clinician_id  BIGINT NOT NULL,
    canonical_id  TEXT NOT NULL,
    used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    use_count     INT NOT NULL DEFAULT 1,
    PRIMARY KEY (clinician_id, canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_food_use_recency ON recent_food_use (clinician_id, used_at DESC);
