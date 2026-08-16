#!/usr/bin/env node
/**
 * Runs allergen-inference.js against every food in the database, tags
 * plausible allergens, marks each tagged item INFERRED_PENDING_REVIEW,
 * and queues a review_queue entry for clinician sign-off.
 *
 * Safe to re-run: uses ON CONFLICT to update rather than duplicate.
 *
 *   DATABASE_URL=postgres://... node populate-allergens.js
 */
const { Pool } = require('pg');
const { inferAllergens } = require('./allergen-inference');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const { rows } = await pool.query('SELECT id, canonical_id, name_ar, name_en, brand FROM food_item');
  console.log('scanning', rows.length, 'foods...');

  let tagged = 0, totalTags = 0;
  const byAllergen = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of rows) {
      const hits = inferAllergens(f.name_ar, f.name_en, f.brand);
      if (hits.size === 0) continue;
      tagged++;
      for (const [allergen, confidence] of hits) {
        await client.query(
          `INSERT INTO food_allergen (food_item_id, allergen, confidence, source_ref)
           VALUES ($1,$2,$3,'auto_inference_v2')
           ON CONFLICT (food_item_id, allergen) DO UPDATE
             SET confidence = CASE
               WHEN food_allergen.confidence = 'clinician_added' THEN food_allergen.confidence
               WHEN food_allergen.confidence = 'verified_source' THEN food_allergen.confidence
               WHEN food_allergen.confidence = 'explicit_label' AND EXCLUDED.confidence IN ('name_keyword','inferred_pattern') THEN food_allergen.confidence
               WHEN food_allergen.confidence = 'name_keyword' AND EXCLUDED.confidence = 'inferred_pattern' THEN food_allergen.confidence
               ELSE EXCLUDED.confidence END,
                 source_ref = CASE
               WHEN food_allergen.confidence IN ('clinician_added','verified_source','explicit_label') THEN food_allergen.source_ref
               ELSE EXCLUDED.source_ref END`,
          [f.id, allergen, confidence]);
        totalTags++;
        byAllergen[allergen] = (byAllergen[allergen] || 0) + 1;
      }
      await client.query(
        `UPDATE food_item SET allergen_profile_status='INFERRED_PENDING_REVIEW'
         WHERE id=$1 AND allergen_profile_status='UNKNOWN'`, [f.id]);
    }
    await client.query(`
      INSERT INTO review_queue (food_item_id, reason, detail)
      SELECT f.id, 'ALLERGEN_PROFILE_REVIEW',
             'مقترح آلي: ' || (SELECT string_agg(fa.allergen||' ('||fa.confidence||')', ', ')
                                FROM food_allergen fa WHERE fa.food_item_id=f.id)
      FROM food_item f
      WHERE f.allergen_profile_status='INFERRED_PENDING_REVIEW'
        AND NOT EXISTS (SELECT 1 FROM review_queue rq
                        WHERE rq.food_item_id=f.id AND rq.reason='ALLERGEN_PROFILE_REVIEW')`);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }

  console.log('items tagged:', tagged, '/', rows.length);
  console.log('total tag rows:', totalTags);
  console.log('by allergen:', byAllergen);
  console.log('Next: clinician reviews via GET /api/review-queue (reason=ALLERGEN_PROFILE_REVIEW)');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
