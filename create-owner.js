#!/usr/bin/env node
'use strict';
const { Pool } = require('pg');
const A = require('./auth');
const [, , email, fullName, password] = process.argv;
if (!email || !fullName || !password) { console.error('Usage: node create-owner.js <email> "<full name>" <password>'); process.exit(1); }
const problem = A.passwordProblem(password);
if (problem) { console.error('Weak password:', problem); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const pool = new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const {rows:[org]} = await db.query(`INSERT INTO organization(name,slug) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,slug`, [`${fullName.trim()} Clinic`, `clinic-${email.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || 'owner'}`]);
    const {rows:[owner]} = await db.query(`INSERT INTO clinician(email,full_name,password_hash,role,organization_id) VALUES($1,$2,$3,'owner',$4) RETURNING id,email,full_name,role,organization_id`, [email.trim(),fullName.trim(),A.hashPassword(password),org.id]);
    await db.query(`INSERT INTO subscription(organization_id,plan_code,status) VALUES($1,'TRIAL','TRIAL') ON CONFLICT DO NOTHING`, [org.id]);
    await db.query('COMMIT');
    console.log('Owner account created:', owner);
    console.log('Organization created/attached:', org);
  }catch(e){await db.query('ROLLBACK');if(e.code==='23505')console.error('An account or organization already exists.');else console.error('Failed:',e.message);process.exitCode=1;}finally{db.release();await pool.end();}
})();
