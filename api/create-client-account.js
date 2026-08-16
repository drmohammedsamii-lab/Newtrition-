#!/usr/bin/env node
const {Pool}=require('pg');const A=require('./client-auth');
const [, , clientId,email,password]=process.argv;
if(!clientId||!email||!password){console.error('Usage: node create-client-account.js <clientId> <email> <password>');process.exit(1);}
const problem=A.passwordProblem(password);if(problem){console.error(problem);process.exit(1);}
if(!process.env.DATABASE_URL){console.error('DATABASE_URL is not set.');process.exit(1);}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{try{const q=await pool.query('SELECT id FROM client WHERE id=$1',[clientId]);if(!q.rows.length)throw new Error('client_not_found');const {rows}=await pool.query(`INSERT INTO client_account(client_id,email,password_hash) VALUES($1,$2,$3) RETURNING id,client_id,email`,[clientId,email.trim().toLowerCase(),A.hashPassword(password)]);console.log('Client account created:',rows[0]);}catch(e){console.error('Failed:',e.code==='23505'?'email_or_account_already_exists':e.message);process.exitCode=1;}finally{await pool.end();}})();
