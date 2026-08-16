#!/usr/bin/env node
'use strict';
const {Pool}=require('pg');
if(!process.env.DATABASE_URL){console.error('DATABASE_URL not set');process.exit(1);}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await db.query(`INSERT INTO review_queue(food_item_id,reason,detail)
      SELECT f.id,'FOOD_ROLE_REVIEW','food_role is UNKNOWN'
      FROM food_item f
      WHERE f.food_role='UNKNOWN'
        AND NOT EXISTS(SELECT 1 FROM review_queue rq WHERE rq.food_item_id=f.id AND rq.reason='FOOD_ROLE_REVIEW' AND rq.status='PENDING')`);
    await db.query(`INSERT INTO review_queue(food_item_id,reason,detail)
      SELECT f.id,'CALORIE_MACRO_CONFLICT','Stored kcal differs materially from kcal derived from protein/carbs/fat'
      FROM food_item f JOIN nutrition_serving s ON s.food_item_id=f.id
      WHERE s.kcal IS NOT NULL AND s.kcal_from_macros IS NOT NULL
        AND abs(s.kcal-s.kcal_from_macros) > GREATEST(100, s.kcal*0.20)
        AND NOT EXISTS(SELECT 1 FROM review_queue rq WHERE rq.food_item_id=f.id AND rq.reason='CALORIE_MACRO_CONFLICT' AND rq.status='PENDING')`);
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  const {rows}=await pool.query(`SELECT reason,count(*)::int AS n FROM review_queue WHERE status='PENDING' GROUP BY reason ORDER BY reason`);
  console.log(rows); await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});
