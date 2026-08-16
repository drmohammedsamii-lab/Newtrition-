#!/usr/bin/env node
'use strict';
/*
 * Newtrition migration runner (Node + pg).
 * Exists because the Railway runtime image has Node but NOT psql,
 * so database/setup.sh cannot run there.
 *
 * Safety:
 *  - Idempotent: records applied files in schema_migrations and skips them.
 *  - Guards seed_foods.sql: skipped if food_item already has rows (no duplicate seeding).
 *  - Resolves psql's "\i file" meta-command manually (migrate_v3_7.sql uses it).
 *  - Never exits non-zero on an already-applied state.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.join(__dirname, 'database');
const ORDER = [
  'schema.sql', 'seed_foods.sql', 'substitution_v3_1.sql', 'schema_auth.sql',
  'migrate_v3_7.sql', 'migrate_v3_8_review.sql', 'migrate_v3_9_remediation.sql',
  'migrate_v4_0_food_intelligence.sql', 'migrate_v4_1_constraints.sql',
  'migrate_v5_0_quality.sql', 'migrate_v5_1_repair.sql', 'migrate_v5_2.sql',
  'migrate_v5_4_workflow.sql', 'migrate_v6_7_ai_draft.sql', 'migrate_v7_0_client_portal.sql',
  'migrate_v8_0_saas.sql', 'schema_allergen_safety.sql', 'migrate_v8_4_hardening.sql',
  'migrate_v8_4_3_integration.sql', 'migrate_v8_5_final_core.sql',
  'migrate_v8_5_1_allergen_source_ref.sql'
];

// psql's \i is a client meta-command; pg does not understand it. Inline the file.
function expand(file, seen = new Set()) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) return null;
  if (seen.has(file)) return '';
  seen.add(file);
  return fs.readFileSync(full, 'utf8')
    .split('\n')
    .map(line => {
      const m = line.match(/^\s*\\i(?:nclude)?\s+(\S+)\s*$/);
      if (!m) return line;
      const inc = expand(path.basename(m[1]), seen);
      return inc === null ? `-- [runner] include not found: ${m[1]}` : inc;
    })
    .join('\n');
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL not set');
    process.exit(1);
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const done = new Set(
    (await db.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
  );

  let applied = 0, skipped = 0;

  for (const file of ORDER) {
    if (done.has(file)) { console.log(`[skip]  ${file} (already applied)`); skipped++; continue; }

    const sql = expand(file);
    if (sql === null) { console.log(`[miss]  ${file} (not in repo)`); continue; }

    // Never re-seed foods into a non-empty catalog.
    if (file === 'seed_foods.sql') {
      const { rows } = await db.query(`SELECT to_regclass('public.food_item') AS t`);
      if (rows[0].t) {
        const c = await db.query('SELECT count(*)::int AS n FROM food_item');
        if (c.rows[0].n > 0) {
          console.log(`[skip]  ${file} (food_item already has ${c.rows[0].n} rows)`);
          await db.query('INSERT INTO schema_migrations(filename) VALUES($1) ON CONFLICT DO NOTHING', [file]);
          skipped++;
          continue;
        }
      }
    }

    process.stdout.write(`[run]   ${file} ... `);
    try {
      await db.query('BEGIN');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(filename) VALUES($1) ON CONFLICT DO NOTHING', [file]);
      await db.query('COMMIT');
      console.log('OK');
      applied++;
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      console.log('FAILED');
      console.error(`\n[migrate] ${file} failed:\n  ${e.message}\n`);
      await db.end();
      process.exit(1);
    }
  }

  const cov = await db.query('SELECT * FROM v_food_data_coverage').catch(() => ({ rows: [] }));
  console.log(`\n[migrate] applied=${applied} skipped=${skipped}`);
  if (cov.rows[0]) console.log('[migrate] coverage:', JSON.stringify(cov.rows[0]));
  await db.end();
})().catch(e => { console.error('[migrate] fatal:', e.message); process.exit(1); });
