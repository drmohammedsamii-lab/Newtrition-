-- V8.11 — Condition Library (first 3 conditions, per Dr. Sami's own weight-loss
-- guide chapter 13 content — not new clinical claims, just structuring what he
-- already published). Lets a clinician tag a client with a condition and see
-- the relevant considerations while building the plan.

CREATE TABLE IF NOT EXISTS condition_library (
    id          BIGSERIAL PRIMARY KEY,
    key         TEXT UNIQUE NOT NULL,
    name_ar     TEXT NOT NULL,
    summary     TEXT NOT NULL,          -- from Dr. Sami's own guide, ch.13
    considerations TEXT,                -- practical guidance for plan-building
    source      TEXT DEFAULT 'دليل التخسيس العملي - فصل 13',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_condition (
    client_id     BIGINT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
    condition_id  BIGINT NOT NULL REFERENCES condition_library(id),
    noted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, condition_id)
);

INSERT INTO condition_library (key, name_ar, summary, considerations) VALUES
('insulin_resistance', 'مقاومة الإنسولين',
 'مقاومة الإنسولين مش بتمنع النزول، لكن ممكن تصعبه شوية.',
 'توزيع البروتين والألياف على مدار اليوم بيساعد على استقرار السكر والشبع.'),
('pcos', 'تكيّس المبايض (PCOS)',
 'ممكن يصعب النزول شوية بسبب مقاومة الإنسولين وزيادة الشهية عند بعض الحالات، لكنه لا يمنعه.',
 'مش لازم توقف النشويات؛ المهم الجودة والكمية والبروتين.'),
('thyroid', 'قصور الغدة الدرقية',
 'قصور الغدة غير المعالَج ممكن يبطئ النزول، لكن بعد العلاج المناسب الأمور غالبًا بتتحسن.',
 'وجود أعراض أو تشخيص معروف يستحق تقييمًا طبيًا مباشرًا قبل تعديل الخطة بناءً عليه.')
ON CONFLICT (key) DO NOTHING;
