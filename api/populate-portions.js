#!/usr/bin/env node
'use strict';
const {Pool}=require('pg');
if(!process.env.DATABASE_URL){console.error('DATABASE_URL not set');process.exit(1);}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const {rows}=await pool.query(`SELECT id, portion_label, portion_grams FROM food_item WHERE portion_label IS NOT NULL OR portion_grams IS NOT NULL`);
  let inserted=0;
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    for(const f of rows){
      if(!f.portion_label && !f.portion_grams) continue;
      const r=await db.query(`INSERT INTO portion_option(food_item_id,label,grams,is_default,source_ref)
        VALUES($1,$2,$3,TRUE,'food_item_existing_portion')
        ON CONFLICT DO NOTHING RETURNING id`,[f.id,f.portion_label||`${f.portion_grams} g`,f.portion_grams]);
      if(r.rows.length) inserted++;
    }
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  console.log({candidate_foods:rows.length, inserted_portions:inserted});
  await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});
