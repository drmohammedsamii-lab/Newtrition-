-- V8.8 — Clinical Evidence Registry.
-- Tracks sensitive clinical claims (hormones, PCOS, cortisol, insulin resistance,
-- fasting, supplements...) used anywhere in content/engine, each with its own
-- source, evidence level, and reviewer sign-off — separate from per-food
-- nutrition evidence (the existing `evidence` table), which this does not touch.

CREATE TABLE IF NOT EXISTS evidence_registry (
    id             BIGSERIAL PRIMARY KEY,
    topic          TEXT NOT NULL,             -- e.g. 'Insulin Resistance', 'Cortisol', 'PCOS'
    claim          TEXT NOT NULL,              -- the exact claim/sentence being tracked
    source_type    TEXT,                       -- Guideline / Trial / Review / Clinical Protocol
    source         TEXT,                       -- citation or protocol name
    publication_date DATE,
    evidence_level TEXT NOT NULL DEFAULT 'pending_review'
                   CHECK (evidence_level IN ('evidence_backed','clinical_protocol','source_derived',
                                              'estimated','inferred','pending_review')),
    status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','needs_update','retired')),
    used_in        TEXT,                       -- free text: 'Weight-loss guide ch.13', 'AI copilot', ...
    reviewer       TEXT,
    review_date    DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_registry_topic ON evidence_registry (topic);
CREATE INDEX IF NOT EXISTS idx_evidence_registry_status ON evidence_registry (status);
