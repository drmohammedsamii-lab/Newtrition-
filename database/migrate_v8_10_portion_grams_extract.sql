-- V8.10 — Portion Engine (partial, safe first pass).
-- Extracts gram values ALREADY explicitly written inside portion_label text
-- (e.g. "100 جم", "~200جم لحم صافي") into the existing food_item.portion_grams
-- column. Pure text extraction of what the label already states — no values
-- invented or estimated. Unit-word labels (معلقة/كوب/حبة with no number) are
-- deliberately left NULL: converting those to grams needs the clinician's
-- review of a conversion table, not an automated guess.
UPDATE food_item
SET portion_grams = (regexp_match(portion_label, '(\d+(?:\.\d+)?)\s*(?:جم|جرام|g\b)'))[1]::numeric
WHERE portion_label ~ '\d+(?:\.\d+)?\s*(?:جم|جرام|g\b)'
  AND portion_grams IS NULL;
