'use strict';
/* Newtrition smoke test — structural guards that must hold before the app is
 * even started. Extended in V8.5.2 to guard the defects found at runtime. */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = __dirname;

const required = [
  'server.js','index.html','client.html','client-manifest.json','client-sw.js',
  'auth.js','client-auth.js','nutrition-engine.js','optimizer.js','clinical-constraints.js',
  'weekly-quality-gate.js','migrate.js',
  'database/migrate_v8_5_1_allergen_source_ref.sql',
  'database/migrate_v8_5_2_runtime_repair.sql',
  'database/migrate_v8_5_3_client_profile.sql',
  'content/index.html','content/recipes.html','content/exercise.html',
  'content/exchange.html','content/faq.html'
];
for (const f of required) if (!fs.existsSync(path.join(root,f))) throw new Error(`missing:${f}`);

const js = fs.readdirSync(root).filter(f=>f.endsWith('.js'));
for (const f of js) cp.execFileSync(process.execPath,['--check',f],{stdio:'ignore'});

const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
if (lock.version !== pkg.version) throw new Error(`lock version drift: ${lock.version} vs ${pkg.version}`);

const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
for (const route of ["app.get('/',", "app.get('/index.html',", "app.get('/client',",
                     "app.get('/client-manifest.json',", "app.get('/client-sw.js',"]) {
  if (!server.includes(route)) throw new Error(`missing route:${route}`);
}

// V8.5.5: static content library must stay registered and public (before
// the auth middleware), same as the other static pages above.
for (const route of ["app.get('/resources',", "app.get('/content/recipes.html',",
                     "app.get('/content/exercise.html',", "app.get('/content/exchange.html',",
                     "app.get('/content/faq.html',"]) {
  if (!server.includes(route)) throw new Error(`missing content route:${route}`);
}
const authMwIdx = server.indexOf('A.attachUser(pool)');
const resourcesIdx = server.indexOf("app.get('/resources'");
if (authMwIdx === -1 || resourcesIdx === -1 || resourcesIdx > authMwIdx)
  throw new Error('resources routes must be registered before the auth middleware (public content)');


const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
for (const marker of ['data-view="plan"','id="cClient"','function savePlanDraft','function addSearchToPlan']) {
  if (!html.includes(marker)) throw new Error(`missing UI:${marker}`);
}

/* --- V8.5.2 guards: every defect below was a live HTTP 500 --- */

// Both migration runners must apply the same list, or two deployments diverge.
// Two legitimate exceptions: files pulled in by another file's \i include, and
// migrate_v3_1.sql, a legacy in-place upgrade bundle for pre-v3.1 databases
// whose objects are all created by the normal fresh-build path.
const migrateJs = fs.readFileSync(path.join(root,'migrate.js'),'utf8');
const setupSh   = fs.readFileSync(path.join(root,'database/setup.sh'),'utf8');
const sqlDir    = path.join(root,'database');
const sqlFiles  = fs.readdirSync(sqlDir).filter(f=>f.endsWith('.sql'));
const LEGACY_NOT_APPLIED = new Set(['migrate_v3_1.sql']);
const includedByAnother = new Set();
for (const f of sqlFiles) {
  const body = fs.readFileSync(path.join(sqlDir,f),'utf8');
  for (const m of body.matchAll(/^\s*\\i(?:nclude)?\s+(\S+)\s*$/gm))
    includedByAnother.add(path.basename(m[1]));
}
for (const f of sqlFiles) {
  if (LEGACY_NOT_APPLIED.has(f) || includedByAnother.has(f)) continue;
  if (!migrateJs.includes(f)) throw new Error(`migrate.js does not apply:${f}`);
  if (!setupSh.includes(f))   throw new Error(`setup.sh does not apply:${f}`);
}

// Every relation/function/column the runtime repair created must stay created.
const repair = fs.readFileSync(path.join(root,'database/migrate_v8_5_2_runtime_repair.sql'),'utf8');
for (const obj of ['daily_log','meal_checkin','v_client_visible_plan','v_adherence',
                   'find_substitutes','superseded_by','must_change_password','notes']) {
  if (!repair.includes(obj)) throw new Error(`runtime repair lost:${obj}`);
}

// evidence has no surrogate id; ordering by it broke the whole plan lifecycle.
if (/ORDER BY[^;]*\bev\.id\b/i.test(server))
  throw new Error('server.js orders by nonexistent evidence.id');

// A meal slot holds many items. Overwriting hid unvalidated foods from the gate.
if (/d\.items\[it\.slot\]\s*=\s*row/.test(server))
  throw new Error('quality gate slot overwrite regression: multi-item meals would be hidden');

// V8.5.3: registration must collect enough data to compute targets, and land
// on the plan builder with them computed — not a bare prompt() into the
// constraints/allergy card.
if (/const name = prompt\('اسم العميلة:'\)/.test(html))
  throw new Error('openNewClient regressed to the bare prompt() intake');
if (!html.includes('function openClientInPlan'))
  throw new Error('missing openClientInPlan: new clients would land on the wrong page');
if (!html.includes('id="ncWt"') || !html.includes('id="ncHt"') || !html.includes('id="ncAge"'))
  throw new Error('client intake form lost its age/height/weight fields');
if ((html.match(/function openNewClient/g) || []).length !== 1)
  throw new Error('duplicate openNewClient definition: the later one silently wins');

// V8.6.0: api() must read the server's actual error field, or every failure
// in the app shows the useless string "request_failed".
if (!html.includes("payload.error || payload.message"))
  throw new Error("api() error handling regressed: must read the server's real error field");

// V8.6.0: the quality-gate submit rejection must be explained to the
// clinician, not surfaced as a generic failure.
if (!html.includes('quality_gate_not_passed') || !html.includes('explainBlockers'))
  throw new Error('submitPlan lost its quality-gate blocker explanation');

const client = fs.readFileSync(path.join(root,'client.html'),'utf8');
// V8.6.0: id="login" collided with `const login=...`, silently breaking the
// client portal's login button (login.onclick=login targeted the function,
// not the element). Guard the fix by name.
if (!client.includes('const doLogin=') || client.includes('login.onclick=login'))
  throw new Error('client.html login/doLogin id-collision regression');

// V8.6.0: the client portal's /api/client/plan handler returns {plan, days,
// items} as siblings; items are not nested inside each day. Rendering with
// day.items silently broke every released plan's display.
if (client.includes('day.items.map') || !client.includes('itemsByDay'))
  throw new Error('client.html loadPlan regressed to the day.items shape mismatch');

console.log(`V${pkg.version} smoke: PASS`);
