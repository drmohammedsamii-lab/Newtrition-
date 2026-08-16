-- Newtrition v3.1 substitution engine.
-- Uses the hardened optimizer eligibility view and enforces same-role + protein floor.
CREATE OR REPLACE FUNCTION find_substitutes_v31(p_canonical_id TEXT, p_limit INT DEFAULT 12)
RETURNS TABLE (
  canonical_id TEXT,
  name_ar TEXT,
  name_en TEXT,
  food_role food_role,
  category TEXT,
  kcal NUMERIC,
  protein_g NUMERIC,
  carb_g NUMERIC,
  fat_g NUMERIC,
  evidence_tier evidence_tier,
  distance NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH src AS (
    SELECT f.id, f.food_role AS role, s.kcal AS src_kcal, s.protein_g AS src_protein
    FROM food_item f
    JOIN nutrition_serving s ON s.food_item_id=f.id
    WHERE f.canonical_id=p_canonical_id
    LIMIT 1
  )
  SELECT v.canonical_id, v.name_ar, v.name_en, v.food_role, v.category,
         v.kcal, v.protein_g, v.carb_g, v.fat_g, v.evidence_tier,
         ROUND(
           ABS(v.kcal-src.src_kcal)/GREATEST(src.src_kcal,1)*100
           + CASE WHEN src.src_protein IS NOT NULL AND v.protein_g IS NOT NULL
                  THEN ABS(v.protein_g-src.src_protein)/GREATEST(src.src_protein,1)*80 ELSE 25 END
         ,1) AS distance
  FROM src
  JOIN v_optimizer_eligible v ON v.food_role=src.role
  WHERE v.canonical_id <> p_canonical_id
    AND v.kcal BETWEEN src.src_kcal*0.6 AND src.src_kcal*1.4
    AND (src.src_protein IS NULL OR v.protein_g IS NULL OR v.protein_g >= src.src_protein*0.70)
  ORDER BY distance ASC, v.name_ar
  LIMIT GREATEST(1, LEAST(p_limit,30));
END;
$$ LANGUAGE plpgsql STABLE;
