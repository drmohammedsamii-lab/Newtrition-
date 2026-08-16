/**
 * Newtrition API v4.0
 * Canonical catalog + auth/RBAC + clients + persistent plans + review queue.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const A = require('./auth');
const NutritionEngine = require('./nutrition-engine');
const Optimizer = require('./optimizer');
const PlanningRules = require('./planning-rules');
const DataQuality = require('./data-quality-engine');
const ReviewEngine = require('./review-engine');
const Remediation = require('./review-remediation');
const FoodIntel = require('./food-intelligence');
const ClinicalConstraints = require('./clinical-constraints');
const PortionEngine = require('./portion-engine');
const ClinicalRules = require('./clinical-rules');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.use(express.json({ limit: '512kb' }));

// Conservative security headers. Inline JS remains in the current shell, so CSP
// is tightened as much as possible without breaking the supplied frontend.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/api', (req,res,next)=>{ res.setHeader('Cache-Control','no-store'); next(); });
app.use(A.attachUser(pool));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const numberOrNull = v => (v === undefined || v === null || v === '' ? null : Number(v));
const finiteNonNegative = v => Number.isFinite(Number(v)) && Number(v) >= 0;

async function assertOwnedClient(client, clientId, clinicianId) {
  const { rows } = await client.query(
    'SELECT id, full_name FROM client WHERE id = $1 AND clinician_id = $2', [clientId, clinicianId]
  );
  return rows[0] || null;
}

async function getPlanOwner(clientOrPool, planId, clinicianId) {
  const { rows } = await clientOrPool.query(
    'SELECT plan_id, client_id FROM v_plan_owner WHERE plan_id = $1 AND clinician_id = $2',
    [planId, clinicianId]
  );
  return rows[0] || null;
}

function validateReviewPayload(body) {
  const fields = ['kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g'];
  for (const f of fields) {
    const value = numberOrNull(body[f]);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return `${f}_invalid`;
  }
  if (body.decision && !['APPROVED','REJECTED','NEEDS_SOURCE'].includes(body.decision)) return 'bad_decision';
  return null;
}

function planPayloadIsValid(payload) {
  if (!payload || !Array.isArray(payload.days) || payload.days.length < 1 || payload.days.length > 7) return false;
  const seenDays = new Set();
  for (const d of payload.days) {
    const di = Number(d.day_index);
    if (!Number.isInteger(di) || di < 0 || di > 6 || seenDays.has(di)) return false;
    seenDays.add(di);
    if (!Array.isArray(d.items)) return false;
    for (const i of d.items) {
      if (!i || !i.slot) return false;
      const hasCanonical = Boolean(i.canonical_id);
      const hasCustom = Boolean(i.custom_name);
      if (hasCanonical === hasCustom) return false;
      if (i.qty !== undefined && (!Number.isFinite(Number(i.qty)) || Number(i.qty) <= 0)) return false;
      if (hasCustom && i.custom_kcal !== undefined && i.custom_kcal !== null && (!Number.isFinite(Number(i.custom_kcal)) || Number(i.custom_kcal) < 0)) return false;
    }
  }
  return true;
}

/* ---------------- Authentication ---------------- */

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  const { id, email, full_name, role } = req.user;
  res.json({ id, email, full_name, role });
});

app.post('/api/auth/login', A.requireCsrfHeader, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const ip = A.clientIp(req);
  const deny = () => res.status(401).json({ error: 'invalid_credentials', message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });

  if (!email || !password) return deny();

  const limits = await A.tooManyFailures(pool, email, ip);
  if (limits.emailBlocked || limits.ipBlocked) {
    // Do not keep extending the lockout window by recording additional failures.
    return res.status(429).json({ error: 'too_many_attempts', message: 'محاولات كتيرة. استني ١٥ دقيقة وحاول تاني' });
  }

  const { rows } = await pool.query(
    'SELECT id, email, full_name, role, password_hash, is_active FROM clinician WHERE lower(email) = lower($1)', [email]
  );
  const u = rows[0];
  const hashToCheck = u?.password_hash || A.DUMMY_PASSWORD_HASH;
  const passwordOk = await A.verifyPassword(password, hashToCheck);

  if (!u || !u.is_active || !passwordOk) {
    await A.recordAttempt(pool, email, ip, false);
    return deny();
  }

  await A.recordAttempt(pool, email, ip, true);
  await pool.query('DELETE FROM login_attempt WHERE lower(email)=lower($1) AND NOT successful', [email]);
  await pool.query('UPDATE clinician SET last_login_at = now() WHERE id = $1', [u.id]);
  const { token, expires } = await A.createSession(pool, u.id, req);
  A.setSessionCookie(res, token, expires);
  req.user = u;
  // Audit failure is deliberately visible here rather than silently swallowed.
  try { await A.audit(pool, req, 'LOGIN', u.email); } catch (e) { console.error('audit failed', e); }
  res.json({ id: u.id, email: u.email, full_name: u.full_name, role: u.role });
}));

app.post('/api/auth/logout', A.requireCsrfHeader, wrap(async (req, res) => {
  await A.revokeSession(pool, req.cookies?.[A.COOKIE]);
  A.clearSessionCookie(res);
  res.json({ ok: true });
}));

app.post('/api/auth/users', A.requireCsrfHeader, A.requireRole('owner'), wrap(async (req, res) => {
  const { email, full_name, password, role = 'clinician' } = req.body;
  if (!email || !full_name) return res.status(400).json({ error: 'email_and_name_required' });
  const problem = A.passwordProblem(password);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
  if (!['owner','clinician','assistant'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO clinician (email, full_name, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id, email, full_name, role`,
      [String(email).trim(), String(full_name).trim(), A.hashPasswordSync(password), role]
    );
    await A.audit(client, req, 'CREATE_USER', rows[0].email);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    throw e;
  } finally { client.release(); }
}));

app.post('/api/auth/password', A.requireCsrfHeader, A.requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body;
  const problem = A.passwordProblem(new_password);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });

  const { rows } = await pool.query('SELECT password_hash FROM clinician WHERE id = $1', [req.user.id]);
  if (!rows.length || !(await A.verifyPassword(current_password || '', rows[0].password_hash)))
    return res.status(401).json({ error: 'wrong_password', message: 'كلمة المرور الحالية غير صحيحة' });

  const currentTokenHash = req.cookies?.[A.COOKIE]
    ? crypto.createHash('sha256').update(req.cookies[A.COOKIE]).digest('hex') : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE clinician SET password_hash = $2 WHERE id = $1', [req.user.id, A.hashPasswordSync(new_password)]);
    await client.query(`UPDATE session SET revoked_at = now()
                        WHERE clinician_id = $1 AND ($2::text IS NULL OR token_hash <> $2) AND revoked_at IS NULL`,
      [req.user.id, currentTokenHash]);
    await A.audit(client, req, 'CHANGE_PASSWORD', req.user.email);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

/* Everything past this point requires a signed-in user. */
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  return A.requireAuth(req, res, next);
});

/* ---------------- Catalog ---------------- */

app.get('/api/foods', wrap(async (req, res) => {
  const { q = '', category, entity_type, limit = 50, offset = 0, includeReview } = req.query;
  // Review/raw catalog access is limited to owner/clinician.
  if (includeReview === '1' && !['owner','clinician'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const quality = req.query.quality || 'strict';
  if (!['strict','warning','review','all'].includes(quality)) return res.status(400).json({error:'bad_quality_lane'});
  let table;
  const isFullReview = includeReview === '1';
  if (isFullReview) table='food_item_full';
  else if (quality === 'strict') table='v_optimizer_eligible_strict';
  else if (quality === 'warning') table='v_optimizer_eligible_with_warning';
  else table='v_food_quality';
  const params = [];
  const where = [];
  if (q) { params.push(`%${q}%`); where.push(`(name_ar ILIKE $${params.length} OR coalesce(name_en,'') ILIKE $${params.length})`); }
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (entity_type) { params.push(entity_type); where.push(`entity_type = $${params.length}`); }
  if (!isFullReview && quality === 'review') where.push(`quality_class = 'REVIEW_REQUIRED'`);
  if (!isFullReview && quality === 'warning') where.push(`quality_class IN ('AUTO_ELIGIBLE','AUTO_WITH_WARNING')`);
  if (!isFullReview && quality === 'all') where.push(`quality_class <> 'BLOCKED'`);

  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  params.push(Math.max(Number(offset) || 0, 0));

  const sql = `SELECT * FROM ${table}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY name_ar
               LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  res.json({ count: rows.length, items: rows });
}));

app.get('/api/foods/:canonicalId', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT f.*, 
           to_jsonb(s) - 'food_item_id' AS serving,
           to_jsonb(p) - 'food_item_id' AS per100,
           to_jsonb(e) - 'food_item_id' AS evidence,
           COALESCE((SELECT jsonb_agg(fa.allergen ORDER BY fa.allergen) FROM food_allergen fa WHERE fa.food_item_id=f.id), '[]'::jsonb) AS allergens
    FROM food_item f
    LEFT JOIN nutrition_serving s ON s.food_item_id = f.id
    LEFT JOIN nutrition_per100 p ON p.food_item_id = f.id
    LEFT JOIN evidence e ON e.food_item_id = f.id
    WHERE f.canonical_id = $1`, [req.params.canonicalId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
}));

app.get('/api/foods/:canonicalId/substitutes', wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 30);
  const { rows } = await pool.query('SELECT * FROM find_substitutes_v31($1, $2)', [req.params.canonicalId, limit]);
  res.json({ substitutes: rows });
}));

/* ---------------- Clients ---------------- */

app.get('/api/clients', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, gender, birth_year, height_cm, goal, created_at
     FROM client WHERE clinician_id = $1 ORDER BY id DESC`, [req.user.id]);
  res.json({ items: rows });
}));

app.post('/api/clients', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const { full_name, gender, birth_year, height_cm, goal, conditions, medications, gi_notes, habits, sleep, stress, ramadan_mode, carb_cycling, diet_pattern, exclusions = [] } = req.body;
  if (!full_name || String(full_name).trim().length < 2) return res.status(400).json({ error: 'full_name_required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO client
      (clinician_id, full_name, gender, birth_year, height_cm, goal, conditions, medications, gi_notes, habits, sleep, stress, ramadan_mode, carb_cycling, diet_pattern)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.user.id, String(full_name).trim(), gender || null, numberOrNull(birth_year), numberOrNull(height_cm), goal || null,
       conditions || null, medications || null, gi_notes || null, habits || null, sleep || null, stress || null,
       Boolean(ramadan_mode), Boolean(carb_cycling), diet_pattern || null]);
    for (const ex of Array.isArray(exclusions) ? exclusions : []) {
      const term = String(ex.term || ex).trim();
      const kind = String(ex.kind || 'preference');
      if (term && ['allergy','medical','religious','dislike','preference'].includes(kind))
        await client.query('INSERT INTO client_exclusion (client_id, term, kind) VALUES ($1,$2,$3)', [rows[0].id, term, kind]);
    }
    await A.audit(client, req, 'CREATE_CLIENT', String(rows[0].id));
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

app.get('/api/clients/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM client WHERE id = $1 AND clinician_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const exclusions = await pool.query('SELECT id, term, kind FROM client_exclusion WHERE client_id = $1 ORDER BY id', [req.params.id]);
  res.json({ ...rows[0], exclusions: exclusions.rows });
}));

app.put('/api/clients/:id', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const fields = ['full_name','gender','birth_year','height_cm','goal','conditions','medications','gi_notes','habits','sleep','stress','ramadan_mode','carb_cycling','diet_pattern'];
  const allowed = {};
  for (const f of fields) if (req.body[f] !== undefined) allowed[f] = req.body[f];
  if (allowed.full_name !== undefined && String(allowed.full_name).trim().length < 2) return res.status(400).json({ error: 'full_name_required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await assertOwnedClient(client, req.params.id, req.user.id);
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error:'not_found' }); }

    const keys = Object.keys(allowed);
    if (keys.length) {
      const values = keys.map(k => ['birth_year','height_cm'].includes(k) ? numberOrNull(allowed[k]) : allowed[k]);
      const set = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
      const q = await client.query(`UPDATE client SET ${set} WHERE id = $1 AND clinician_id = $${values.length+2} RETURNING *`,
        [req.params.id, ...values, req.user.id]);
      if (!q.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({error:'not_found'}); }
    }

    if (Array.isArray(req.body.exclusions)) {
      await client.query('DELETE FROM client_exclusion WHERE client_id=$1', [req.params.id]);
      for (const ex of req.body.exclusions) {
        const term = String(ex.term || ex).trim();
        const kind = String(ex.kind || 'preference');
        if (term && ['allergy','medical','religious','dislike','preference'].includes(kind))
          await client.query('INSERT INTO client_exclusion (client_id, term, kind) VALUES ($1,$2,$3)', [req.params.id, term, kind]);
      }
    }

    const out = await client.query('SELECT * FROM client WHERE id=$1', [req.params.id]);
    await A.audit(client, req, 'UPDATE_CLIENT', String(req.params.id));
    await client.query('COMMIT');
    res.json(out.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));


/* ---------------- V4.0 Food Intelligence ---------------- */

app.get('/api/foods/:canonicalId/intelligence', wrap(async (req,res)=>{
  const base = await pool.query(`SELECT * FROM v_food_intelligence WHERE canonical_id=$1`, [req.params.canonicalId]);
  if(!base.rows.length) return res.status(404).json({error:'not_found'});
  const food = base.rows[0];
  const [ingredients, allergens, portions] = await Promise.all([
    pool.query(`SELECT ingredient_name, is_major, source_ref FROM food_ingredient fi JOIN food_item f ON f.id=fi.food_item_id WHERE f.canonical_id=$1 ORDER BY is_major DESC, ingredient_name`, [req.params.canonicalId]),
    pool.query(`SELECT allergen FROM food_allergen fa JOIN food_item f ON f.id=fa.food_item_id WHERE f.canonical_id=$1 ORDER BY allergen`, [req.params.canonicalId]),
    pool.query(`SELECT id,label,grams,ml,unit_count,is_default,source_ref FROM portion_option po JOIN food_item f ON f.id=po.food_item_id WHERE f.canonical_id=$1 ORDER BY is_default DESC,id`, [req.params.canonicalId])
  ]);
  res.json({food, ingredients:ingredients.rows, allergens:allergens.rows.map(x=>x.allergen), portions:portions.rows, rules_version:'v4.0-food-intelligence-1'});
}));

app.post('/api/foods/:canonicalId/ingredients', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const name=String(req.body.ingredient_name||'').trim();
  if(!name) return res.status(400).json({error:'ingredient_required'});
  const q=await pool.query('SELECT id FROM food_item WHERE canonical_id=$1',[req.params.canonicalId]);
  if(!q.rows.length) return res.status(404).json({error:'not_found'});
  const r=await pool.query(`INSERT INTO food_ingredient(food_item_id,ingredient_name,is_major,source_ref) VALUES($1,$2,$3,$4)
    ON CONFLICT(food_item_id,ingredient_name) DO UPDATE SET is_major=EXCLUDED.is_major,source_ref=EXCLUDED.source_ref
    RETURNING *`,[q.rows[0].id,name,req.body.is_major!==false,req.body.source_ref||null]);
  await A.audit(pool,req,'UPSERT_FOOD_INGREDIENT',req.params.canonicalId,name);
  res.status(201).json(r.rows[0]);
}));

app.post('/api/foods/:canonicalId/allergens', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const allergen=FoodIntel.normalizeAllergen(req.body.allergen);
  if(!allergen) return res.status(400).json({error:'allergen_required'});
  const q=await pool.query('SELECT id FROM food_item WHERE canonical_id=$1',[req.params.canonicalId]);
  if(!q.rows.length) return res.status(404).json({error:'not_found'});
  const r=await pool.query(`INSERT INTO food_allergen(food_item_id,allergen) VALUES($1,$2)
    ON CONFLICT(food_item_id,allergen) DO NOTHING RETURNING *`,[q.rows[0].id,allergen]);
  await A.audit(pool,req,'UPSERT_FOOD_ALLERGEN',req.params.canonicalId,allergen);
  res.status(201).json({ok:true,allergen});
}));

app.post('/api/foods/:canonicalId/portions', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const label=String(req.body.label||'').trim();
  if(!label) return res.status(400).json({error:'portion_label_required'});
  const grams=numberOrNull(req.body.grams), ml=numberOrNull(req.body.ml), unitCount=numberOrNull(req.body.unit_count);
  if(grams===null && ml===null && unitCount===null) return res.status(400).json({error:'portion_measure_required'});
  if([grams,ml,unitCount].some(v=>v!==null && (!Number.isFinite(v)||v<=0))) return res.status(400).json({error:'portion_measure_invalid'});
  const q=await pool.query('SELECT id FROM food_item WHERE canonical_id=$1',[req.params.canonicalId]);
  if(!q.rows.length) return res.status(404).json({error:'not_found'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    if(req.body.is_default===true) await c.query('UPDATE portion_option SET is_default=FALSE WHERE food_item_id=$1',[q.rows[0].id]);
    const r=await c.query(`INSERT INTO portion_option(food_item_id,label,grams,ml,unit_count,is_default,source_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[q.rows[0].id,label,grams,ml,unitCount,req.body.is_default===true,req.body.source_ref||null]);
    await A.audit(c,req,'CREATE_FOOD_PORTION',req.params.canonicalId,label);
    await c.query('COMMIT'); res.status(201).json(r.rows[0]);
  }catch(e){ await c.query('ROLLBACK'); throw e; } finally{ c.release(); }
}));

app.post('/api/foods/:canonicalId/diet-tags', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const tag=ClinicalConstraints.normalizeKey(req.body.tag);
  if(!tag) return res.status(400).json({error:'diet_tag_required'});
  const q=await pool.query('SELECT id FROM food_item WHERE canonical_id=$1',[req.params.canonicalId]);
  if(!q.rows.length) return res.status(404).json({error:'not_found'});
  const r=await pool.query(`INSERT INTO food_diet_tag(food_item_id,tag,source_ref) VALUES($1,$2,$3)
    ON CONFLICT(food_item_id,tag) DO UPDATE SET source_ref=EXCLUDED.source_ref RETURNING *`,
    [q.rows[0].id,tag,req.body.source_ref||null]);
  await A.audit(pool,req,'UPSERT_FOOD_DIET_TAG',req.params.canonicalId,tag);
  res.status(201).json(r.rows[0]);
}));


app.get('/api/clients/:id/constraints', wrap(async(req,res)=>{
  const owned=await assertOwnedClient(pool,req.params.id,req.user.id); if(!owned) return res.status(404).json({error:'not_found'});
  const [excluded,constraints]=await Promise.all([
    pool.query(`SELECT id,term,kind FROM client_exclusion WHERE client_id=$1 ORDER BY id`,[req.params.id]),
    pool.query(`SELECT id,kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1 ORDER BY kind,constraint_key,value`,[req.params.id])
  ]);
  res.json({exclusions:excluded.rows,constraints:constraints.rows,rules_version:'v4.0-clinical-constraints-1'});
}));

app.put('/api/clients/:id/constraints', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const owned=await assertOwnedClient(pool,req.params.id,req.user.id); if(!owned) return res.status(404).json({error:'not_found'});
  const items=Array.isArray(req.body.constraints)?req.body.constraints:[];
  for(const x of items){
    const kind=String(x.kind||'preference'), key=String(x.constraint_key||'').trim(), value=String(x.value||'').trim(), severity=String(x.severity||'HARD');
    if(!key||!value||!['diet','allergen','medical','cultural','meal','macro','preference'].includes(kind)||!['HARD','SOFT','INFO'].includes(severity)) return res.status(400).json({error:'bad_constraint'});
  }
  const c=await pool.connect();
  try{ await c.query('BEGIN'); await c.query('DELETE FROM client_constraint WHERE client_id=$1',[req.params.id]);
    for(const x of items) await c.query(`INSERT INTO client_constraint(client_id,kind,constraint_key,value,severity,source) VALUES($1,$2,$3,$4,$5,$6)`,[req.params.id,x.kind,x.constraint_key,x.value,x.severity||'HARD',x.source||null]);
    await A.audit(c,req,'UPDATE_CLIENT_CONSTRAINTS',String(req.params.id)); await c.query('COMMIT');
    res.json({ok:true,count:items.length});
  }catch(e){await c.query('ROLLBACK'); throw e;} finally{c.release();}
}));


app.post('/api/clients/:id/constraint-check', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const owned=await assertOwnedClient(pool,req.params.id,req.user.id); if(!owned) return res.status(404).json({error:'not_found'});
  const canonicalId=String(req.body.canonical_id||'').trim();
  if(!canonicalId) return res.status(400).json({error:'canonical_id_required'});
  const [cq,fq]=await Promise.all([
    pool.query('SELECT kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1 ORDER BY id',[req.params.id]),
    pool.query(`SELECT * FROM v_food_candidate_intelligence WHERE canonical_id=$1`,[canonicalId])
  ]);
  if(!fq.rows.length) return res.status(404).json({error:'food_not_found'});
  const constraints=ClinicalConstraints.splitConstraints(cq.rows);
  const result=ClinicalConstraints.evaluateCandidate(fq.rows[0],constraints);
  const portion=PortionEngine.scorePortion(fq.rows[0], req.body.slot || fq.rows[0].category);
  res.json({canonical_id:canonicalId,eligible:result.eligible,reason:result.reason||null,soft_penalty:result.softPenalty||0,portion, rules_version:'v4.1-constraints-1'});
}));

app.get('/api/foods/intelligence/coverage', A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const {rows}=await pool.query(`SELECT
    count(*)::int AS total,
    count(*) FILTER(WHERE ingredient_coverage='STRUCTURED')::int AS ingredients_structured,
    count(*) FILTER(WHERE allergen_coverage='STRUCTURED')::int AS allergens_structured,
    count(*) FILTER(WHERE portion_coverage='COVERED')::int AS portions_covered,
    count(*) FILTER(WHERE quality_class='AUTO_ELIGIBLE')::int AS auto_eligible,
    count(*) FILTER(WHERE quality_class='AUTO_WITH_WARNING')::int AS auto_with_warning,
    count(*) FILTER(WHERE quality_class='REVIEW_REQUIRED')::int AS review_required
    FROM v_food_quality q JOIN v_food_intelligence i ON i.id=q.id`);
  res.json({...rows[0],rules_version:'v4.0-food-intelligence-1'});
}));


/* ---------------- V4.2 Clinical policy ---------------- */
app.get('/api/clients/:id/policy', A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const clientRow=await assertOwnedClient(pool,req.params.id,req.user.id);
  if(!clientRow) return res.status(404).json({error:'not_found'});
  const {rows}=await pool.query('SELECT kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1 ORDER BY id',[req.params.id]);
  const policy=ClinicalRules.buildPolicy({client:clientRow,constraints:rows});
  res.json({policy});
}));

app.post('/api/clients/:id/policy/validate', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async(req,res)=>{
  const clientRow=await assertOwnedClient(pool,req.params.id,req.user.id);
  if(!clientRow) return res.status(404).json({error:'not_found'});
  const {rows}=await pool.query('SELECT kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1 ORDER BY id',[req.params.id]);
  const policy=ClinicalRules.buildPolicy({client:clientRow,constraints:rows});
  const applied=ClinicalRules.applyTargetBounds(req.body.targets||{},policy);
  res.json({policy,adjusted_targets:applied.targets,warnings:applied.warnings});
}));

/* ---------------- Nutrition engine ---------------- */

app.post('/api/engine/targets', A.requireCsrfHeader, A.requireAuth, wrap(async (req,res)=>{
  try{
    const targets=NutritionEngine.calculateTargets({
      age:req.body.age,
      height_cm:req.body.height_cm,
      weight_kg:req.body.weight_kg,
      sex:req.body.sex,
      activity_factor:req.body.activity_factor,
      goal_adjustment:req.body.goal_adjustment,
      protein_gkg:req.body.protein_gkg,
      fat_gkg:req.body.fat_gkg
    });
    res.json({targets, rules_version:'v4.2-clinical-policy-1'});
  }catch(e){ return res.status(400).json({error:e.message||'invalid_body_data'}); }
}));

app.post('/api/engine/generate-week', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const clientId=Number(req.body.client_id);
  if(!Number.isInteger(clientId) || clientId<=0) return res.status(400).json({error:'bad_client_id'});
  const owned=await assertOwnedClient(pool,clientId,req.user.id);
  if(!owned) return res.status(404).json({error:'not_found'});
  const clientRow = await pool.query('SELECT carb_cycling FROM client WHERE id=$1 AND clinician_id=$2',[clientId,req.user.id]);
  const t=req.body.targets || {};
  if(!Number.isFinite(Number(t.kcal)) || Number(t.kcal)<=0 || !Number.isFinite(Number(t.protein)) || Number(t.protein)<0)
    return res.status(400).json({error:'bad_targets'});
  const client=await assertOwnedClient(pool,clientId,req.user.id);
  const constraintRows=await pool.query('SELECT kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1 ORDER BY id',[clientId]);
  const policy=ClinicalRules.buildPolicy({client,constraints:constraintRows.rows});
  const applied=ClinicalRules.applyTargetBounds(t,policy);
  if(policy.warnings.some(w=>w.type==='inverted_range')) return res.status(409).json({error:'invalid_clinical_policy',policy,warnings:policy.warnings});
  const generated=await Optimizer.generateWeek(pool,{targets:applied.targets,clientId,days:7,carbCycling:Boolean(clientRow.rows[0]?.carb_cycling),dayTypeSequence:req.body.day_type_sequence,allowWarnings:Boolean(req.body.allow_warnings)});
  const planBoundCheck=ClinicalRules.evaluatePlanBounds(generated.metrics.averagePerDay||{},policy);
  res.json({days:generated.days, metrics:generated.metrics, quality:generated.quality, day_type_sequence:generated.dayTypeSequence, optimizer:'v4.2-clinical-policy-multi-constraint', policy, target_adjustments:applied.warnings, plan_bound_check:planBoundCheck, generated_at:new Date().toISOString()});
}));

app.get('/api/engine/data-quality', A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const {rows}=await pool.query(`SELECT is_active,kcal,protein_g,carb_g,fat_g,fiber_g,status,evidence_tier FROM v_food_quality`);
  const local=DataQuality.summarize(rows);
  const byCategory=await pool.query(`SELECT category, quality_class, count(*)::int AS n FROM v_food_quality WHERE is_active GROUP BY category, quality_class ORDER BY category, quality_class`);
  res.json({active_records:rows.filter(r=>r.is_active).length,...local,by_category:byCategory.rows,rules_version:'v4.0-food-intelligence-1'});
}));

app.get('/api/engine/data-quality/items', A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const quality=String(req.query.quality||'REVIEW_REQUIRED');
  if(!['AUTO_ELIGIBLE','AUTO_WITH_WARNING','REVIEW_REQUIRED','BLOCKED'].includes(quality)) return res.status(400).json({error:'bad_quality_class'});
  const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200);
  const {rows}=await pool.query(`SELECT * FROM v_food_quality WHERE quality_class=$1 ORDER BY name_ar LIMIT $2`,[quality,limit]);
  res.json({quality_class:quality,count:rows.length,items:rows});
}));

app.get('/api/dashboard/summary', wrap(async (req,res)=>{
  const [{rows:clients},{rows:plans},{rows:reviews},{rows:released}]=await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM client WHERE clinician_id=$1',[req.user.id]),
    pool.query('SELECT count(*)::int AS n FROM plan p JOIN client c ON c.id=p.client_id WHERE c.clinician_id=$1',[req.user.id]),
    pool.query("SELECT count(*)::int AS n FROM review_queue WHERE status='PENDING'"),
    pool.query("SELECT count(*)::int AS n FROM plan p JOIN client c ON c.id=p.client_id WHERE c.clinician_id=$1 AND p.is_released=true",[req.user.id])
  ]);
  res.json({clients:clients[0].n,plans:plans[0].n,pending_reviews:reviews[0].n,released_plans:released[0].n});
}));

/* ---------------- Suggestions with structured client exclusions ---------------- */

app.get('/api/suggest', wrap(async (req, res) => {
  const kcal = Number(req.query.kcal);
  const protein = Number(req.query.protein) || 0;
  const role = req.query.role || null;
  const clientId = req.query.client_id ? Number(req.query.client_id) : null;
  if (!Number.isFinite(kcal) || kcal <= 0) return res.status(400).json({ error: 'bad_kcal' });

  if (clientId) {
    const owned = await assertOwnedClient(pool, clientId, req.user.id);
    if (!owned) return res.status(404).json({ error: 'not_found' });
  }

  const params = [kcal, protein];
  let roleClause = '';
  if (role) { params.push(role); roleClause = `AND f.food_role = $${params.length}`; }
  let clientExClause = '';
  if (clientId) {
    params.push(clientId);
    const p = params.length;
    clientExClause = `
      AND NOT EXISTS (
        SELECT 1 FROM client_exclusion ce
        WHERE ce.client_id = $${p}
          AND (
            f.name_ar ILIKE '%' || ce.term || '%'
            OR coalesce(f.name_en,'') ILIKE '%' || ce.term || '%'
            OR EXISTS (SELECT 1 FROM food_allergen fa WHERE fa.food_item_id=f.id AND lower(fa.allergen)=lower(ce.term))
          )
      )`;
  }

  const { rows } = await pool.query(`
    SELECT f.canonical_id, f.name_ar, f.name_en, f.food_role, f.category, s.kcal, s.protein_g, s.carb_g, s.fat_g,
           e.tier AS evidence_tier, s.status,
           ROUND(abs(s.kcal - $1)/GREATEST($1,1)*100
               + CASE WHEN $2 > 0 AND s.protein_g IS NOT NULL THEN abs(s.protein_g - $2)/GREATEST($2,1)*50 ELSE 0 END, 1) AS distance
    FROM v_optimizer_eligible v
    JOIN food_item f ON f.id = v.id
    JOIN nutrition_serving s ON s.food_item_id = f.id
    LEFT JOIN evidence e ON e.food_item_id = f.id
    WHERE s.kcal BETWEEN $1*0.6 AND $1*1.4
      ${roleClause} ${clientExClause}
    ORDER BY distance ASC, coalesce(e.tier,'unknown') DESC, f.name_ar
    LIMIT 20`, params);
  res.json({ candidates: rows });
}));

/* ---------------- Plan quality preflight ---------------- */
app.post('/api/plans/quality-check', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  if (!planPayloadIsValid(req.body)) return res.status(400).json({error:'invalid_plan_payload'});
  const clientId=Number(req.body.client_id);
  if(!Number.isInteger(clientId) || clientId<=0) return res.status(400).json({error:'bad_client_id'});
  const owned=await assertOwnedClient(pool,clientId,req.user.id);
  if(!owned) return res.status(404).json({error:'not_found'});
  const expanded=[];
  for(const day of req.body.days){
    const items={};
    for(const item of day.items){
      if(item.canonical_id){
        const q=await pool.query(`SELECT f.canonical_id,f.name_ar,f.portion_grams,ns.kcal,ns.protein_g,ns.carb_g,ns.fat_g,ns.fiber_g,ns.status,e.tier AS evidence_tier
          FROM food_item f LEFT JOIN nutrition_serving ns ON ns.food_item_id=f.id LEFT JOIN evidence e ON e.food_item_id=f.id
          WHERE f.canonical_id=$1`,[item.canonical_id]);
        if(q.rows[0]) items[item.slot]={...q.rows[0],slot:item.slot};
        else items[item.slot]={canonical_id:item.canonical_id,slot:item.slot,status:'NOT_FOUND',evidence_tier:'unknown'};
      } else items[item.slot]={...item,status:'CUSTOM',kcal:item.custom_kcal,protein_g:null,carb_g:null,fat_g:null,fiber_g:null};
    }
    expanded.push({day_index:Number(day.day_index),day_type:day.day_type||'medium',items});
  }
  const report=PlanningRules.qualityReport({days:expanded,targets:req.body.targets||{}});
  res.json({ok:report.readyForClinicalReview,blockers:report.blockers,warnings:report.warnings,report});
}));

/* ---------------- Persistent plans ---------------- */

app.get('/api/clients/:id/plans', wrap(async (req, res) => {
  const owned = await assertOwnedClient(pool, req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    `SELECT id, client_id, version, label, target_kcal, target_protein_g, target_carb_g, target_fat_g, target_fiber_g,
            approved_by, approved_at, is_released, created_at
     FROM plan WHERE client_id = $1 ORDER BY version DESC`, [req.params.id]);
  res.json({ items: rows });
}));

app.get('/api/plans/:id', wrap(async (req, res) => {
  const owned = await getPlanOwner(pool, req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'not_found' });
  const planQ = await pool.query('SELECT * FROM plan WHERE id = $1', [req.params.id]);
  const daysQ = await pool.query(`
    SELECT pd.id, pd.day_index, pd.day_name, pd.day_type,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', pi.id, 'slot', pi.slot, 'qty', pi.qty, 'is_locked', pi.is_locked,
        'canonical_id', f.canonical_id, 'name_ar', COALESCE(f.name_ar,pi.custom_name), 'custom_name', pi.custom_name, 'food_role', f.food_role,
        'kcal', ns.kcal, 'protein_g', ns.protein_g, 'carb_g', ns.carb_g, 'fat_g', ns.fat_g, 'fiber_g', ns.fiber_g,
        'evidence_tier', e.tier, 'custom_kcal', pi.custom_kcal
      ) ORDER BY pi.position, pi.id) FILTER (WHERE pi.id IS NOT NULL), '[]'::jsonb) AS items
    FROM plan_day pd
    LEFT JOIN plan_item pi ON pi.plan_day_id = pd.id
    LEFT JOIN food_item f ON f.id = pi.food_item_id
    LEFT JOIN nutrition_serving ns ON ns.food_item_id = f.id
    LEFT JOIN evidence e ON e.food_item_id = f.id
    WHERE pd.plan_id = $1
    GROUP BY pd.id ORDER BY pd.day_index`, [req.params.id]);
  res.json({ plan: planQ.rows[0], days: daysQ.rows });
}));

app.post('/api/clients/:id/plans', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  if (!planPayloadIsValid(req.body)) return res.status(400).json({ error: 'invalid_plan_payload' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await assertOwnedClient(client, req.params.id, req.user.id);
    if (!owned) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }

    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [Number(req.params.id)]);
    const vq = await client.query('SELECT COALESCE(MAX(version),0)+1 AS next FROM plan WHERE client_id = $1', [req.params.id]);
    const version = Number(vq.rows[0].next);
    const targets = req.body.targets || {};
    const { rows: planRows } = await client.query(`INSERT INTO plan
      (client_id, version, label, target_kcal, target_protein_g, target_carb_g, target_fat_g, target_fiber_g)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, version, req.body.label || `Plan v${version}`,
       numberOrNull(targets.kcal), numberOrNull(targets.protein), numberOrNull(targets.carb), numberOrNull(targets.fat), numberOrNull(targets.fiber)]);
    const planId = planRows[0].id;

    const conflicts = [];
    for (const day of req.body.days) {
      const { rows: dayRows } = await client.query(
        'INSERT INTO plan_day (plan_id, day_index, day_name, day_type) VALUES ($1,$2,$3,$4) RETURNING id',
        [planId, Number(day.day_index), day.day_name || null, day.day_type || null]);
      const dayId = dayRows[0].id;
      let position = 0;
      for (const item of day.items) {
        let foodId = null;
        let itemStatus = null;
        if (item.canonical_id) {
          const q = await client.query(`
            SELECT f.id, ns.status, ns.kcal, e.tier
            FROM food_item f
            LEFT JOIN nutrition_serving ns ON ns.food_item_id=f.id
            LEFT JOIN evidence e ON e.food_item_id=f.id
            WHERE f.canonical_id=$1`, [item.canonical_id]);
          if (!q.rows.length) {
            conflicts.push({ canonical_id: item.canonical_id, reason: 'not_found' });
          } else {
            foodId = q.rows[0].id;
            itemStatus = q.rows[0].status;
            if (itemStatus !== 'COMPUTABLE' || q.rows[0].kcal == null || !['high','verified','calculated'].includes(q.rows[0].tier)) {
              conflicts.push({ canonical_id: item.canonical_id, reason: 'not_eligible', status: itemStatus || 'INCOMPLETE', evidence_tier: q.rows[0].tier || 'unknown' });
            }
          }
        }
        await client.query(`INSERT INTO plan_item
          (plan_day_id, food_item_id, slot, qty, is_locked, custom_name, custom_kcal, position)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [dayId, foodId, String(item.slot), Number(item.qty || 1), Boolean(item.is_locked), item.custom_name || null,
           numberOrNull(item.custom_kcal), position++]);
      }
    }

    if (conflicts.length) {
      // The plan is saved for clinician correction but not releasable.
      await client.query('UPDATE plan SET is_released=FALSE WHERE id=$1', [planId]);
    }
    await A.audit(client, req, 'CREATE_PLAN', String(planId), conflicts.length ? 'saved_with_ineligible_items' : 'saved');
    await client.query('COMMIT');
    res.status(201).json({ plan: planRows[0], conflicts });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

/* ---------------- Follow-up ---------------- */

app.get('/api/clients/:id/followups', wrap(async (req,res)=>{
  const owned = await assertOwnedClient(pool, req.params.id, req.user.id);
  if(!owned) return res.status(404).json({error:'not_found'});
  const {rows}=await pool.query(`SELECT id, visit_date, weight_kg, waist_cm, body_fat_pct, adherence_pct, notes, created_at
    FROM followup WHERE client_id=$1 ORDER BY visit_date DESC, id DESC`, [req.params.id]);
  res.json({items:rows});
}));

app.post('/api/clients/:id/followups', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const owned = await assertOwnedClient(pool, req.params.id, req.user.id);
  if(!owned) return res.status(404).json({error:'not_found'});
  const {visit_date, weight_kg, waist_cm, body_fat_pct, adherence_pct, notes}=req.body;
  if(!visit_date) return res.status(400).json({error:'visit_date_required'});
  const vals={weight_kg:numberOrNull(weight_kg), waist_cm:numberOrNull(waist_cm), body_fat_pct:numberOrNull(body_fat_pct), adherence_pct:numberOrNull(adherence_pct)};
  if(vals.weight_kg!==null && vals.weight_kg<=0) return res.status(400).json({error:'weight_invalid'});
  if(vals.waist_cm!==null && vals.waist_cm<=0) return res.status(400).json({error:'waist_invalid'});
  if(vals.body_fat_pct!==null && (vals.body_fat_pct<0 || vals.body_fat_pct>100)) return res.status(400).json({error:'body_fat_invalid'});
  if(vals.adherence_pct!==null && (vals.adherence_pct<0 || vals.adherence_pct>100)) return res.status(400).json({error:'adherence_invalid'});
  const {rows}=await pool.query(`INSERT INTO followup (client_id, visit_date, weight_kg, waist_cm, body_fat_pct, adherence_pct, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.params.id, visit_date, vals.weight_kg, vals.waist_cm, vals.body_fat_pct, vals.adherence_pct, notes||null]);
  await A.audit(pool, req, 'CREATE_FOLLOWUP', `${req.params.id}:${rows[0].id}`);
  res.status(201).json(rows[0]);
}));

/* ---------------- Review queue ---------------- */

app.get('/api/review-queue', A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const status = String(req.query.status || 'PENDING');
  const reason = req.query.reason ? String(req.query.reason) : null;
  const quality = req.query.quality ? String(req.query.quality) : null;
  const minPriority = req.query.min_priority == null ? null : Number(req.query.min_priority);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const params = [status];
  const where = ['status=$1'];
  if (reason) { params.push(reason); where.push(`reason=$${params.length}`); }
  if (quality) { params.push(quality); where.push(`live_quality_class=$${params.length}`); }
  if (Number.isFinite(minPriority)) { params.push(minPriority); where.push(`priority >= $${params.length}`); }
  params.push(limit, offset);
  const { rows } = await pool.query(`
    SELECT * FROM v_review_queue_v38
    WHERE ${where.join(' AND ')}
    ORDER BY priority DESC, created_at ASC, id ASC
    LIMIT $${params.length-1} OFFSET $${params.length}`, params);
  res.json({ count: rows.length, items: rows });
}));

app.get('/api/review-queue/summary', A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const { rows } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE status='PENDING')::int AS pending,
      count(*) FILTER (WHERE status='APPROVED')::int AS approved,
      count(*) FILTER (WHERE status='REJECTED')::int AS rejected,
      count(*) FILTER (WHERE status='NEEDS_SOURCE')::int AS needs_source,
      count(*) FILTER (WHERE status='PENDING' AND priority>=90)::int AS critical,
      count(*) FILTER (WHERE status='PENDING' AND priority BETWEEN 60 AND 89)::int AS high,
      count(*) FILTER (WHERE status='PENDING' AND priority<60)::int AS routine
    FROM review_queue`);
  const byReason = await pool.query(`SELECT reason, count(*)::int AS n FROM review_queue WHERE status='PENDING' GROUP BY reason ORDER BY n DESC, reason`);
  const byQuality = await pool.query(`SELECT quality_class, count(*)::int AS n FROM v_food_quality GROUP BY quality_class ORDER BY quality_class`);
  res.json({summary:rows[0], by_reason:byReason.rows, by_quality:byQuality.rows, rules_version:'v3.8-review-1'});
}));

app.get('/api/review-queue/:id', A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const {rows}=await pool.query('SELECT * FROM v_review_queue_v38 WHERE id=$1',[req.params.id]);
  if(!rows.length) return res.status(404).json({error:'not_found'});
  res.json(rows[0]);
}));

app.post('/api/review-queue/:id/resolve', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const problem = validateReviewPayload(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const { kcal, protein_g, carb_g, fat_g, fiber_g, decision = 'APPROVED', confirm_existing_values = false, source_ref = null, review_notes = null } = req.body;
  if (decision === 'APPROVED' && !confirm_existing_values && [kcal,protein_g,carb_g,fat_g].every(v => v == null || v === '')) {
    return res.status(400).json({error:'explicit_confirmation_required', message:'اعمل تأكيد صريح للقيم الحالية أو أدخل القيم المصححة قبل الاعتماد.'});
  }
  const resolvedBy = `${req.user.full_name} <${req.user.email}>`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query('SELECT food_item_id, status FROM review_queue WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!q.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({error:'not_found'}); }
    const foodId = q.rows[0].food_item_id;
    let nextStatus = 'INCOMPLETE';
    if (decision === 'APPROVED') {
      await client.query(`UPDATE nutrition_serving
        SET kcal=coalesce($2,kcal), protein_g=coalesce($3,protein_g), carb_g=coalesce($4,carb_g),
            fat_g=coalesce($5,fat_g), fiber_g=coalesce($6,fiber_g)
        WHERE food_item_id=$1`, [foodId, numberOrNull(kcal), numberOrNull(protein_g), numberOrNull(carb_g), numberOrNull(fat_g), numberOrNull(fiber_g)]);
      const q2 = await client.query('SELECT kcal, protein_g, carb_g, fat_g, status FROM nutrition_serving WHERE food_item_id=$1', [foodId]);
      const n = q2.rows[0];
      nextStatus = n && n.kcal != null && n.protein_g != null && n.carb_g != null && n.fat_g != null ? 'COMPUTABLE' : 'INCOMPLETE';
      if (nextStatus !== 'COMPUTABLE') {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'still_incomplete', message:'لا يمكن اعتماد الصنف قبل اكتمال السعرات والبروتين والكارب والدهون.'});
      }
      await client.query(`UPDATE nutrition_serving SET status='COMPUTABLE' WHERE food_item_id=$1`, [foodId]);
      await client.query(`UPDATE evidence SET verified_by=$2, verified_at=now(), tier='verified', source_ref=coalesce($3,source_ref)
                          WHERE food_item_id=$1`, [foodId, resolvedBy, source_ref]);
    }
    await client.query(`UPDATE review_queue SET status=$2, resolved_by=$3, resolved_at=now(), source_ref=coalesce($4,source_ref), review_notes=coalesce($5,review_notes)
      WHERE id=$1`, [req.params.id, decision, resolvedBy, source_ref, review_notes]);
    await A.audit(client, req, 'RESOLVE_REVIEW', req.params.id, `${decision}:${nextStatus}`);
    await client.query('COMMIT');
    res.json({ok:true, resolved_by:resolvedBy, nutrition_status:nextStatus});
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

app.post('/api/review-queue/bulk-resolve', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))].slice(0,50) : [];
  const decision = req.body.decision || 'APPROVED';
  const confirmExisting = Boolean(req.body.confirm_existing_values);
  if (!ids.length) return res.status(400).json({error:'ids_required'});
  if (!['APPROVED','REJECTED','NEEDS_SOURCE'].includes(decision)) return res.status(400).json({error:'bad_decision'});
  if (decision === 'APPROVED' && !confirmExisting) return res.status(400).json({error:'explicit_confirmation_required'});
  const resolvedBy = `${req.user.full_name} <${req.user.email}>`;
  const client = await pool.connect();
  const results=[];
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      const q=await client.query(`SELECT rq.id, rq.food_item_id, v.quality_class, v.kcal, v.protein_g, v.carb_g, v.fat_g
        FROM review_queue rq LEFT JOIN v_food_quality v ON v.id=rq.food_item_id
        WHERE rq.id=$1 AND rq.status='PENDING' FOR UPDATE`,[id]);
      if(!q.rows.length){ results.push({id,ok:false,error:'not_found_or_not_pending'}); continue; }
      const r=q.rows[0];
      if(decision==='APPROVED'){
        if(!['AUTO_ELIGIBLE','AUTO_WITH_WARNING'].includes(r.quality_class)){
          results.push({id,ok:false,error:'still_requires_data_correction',quality_class:r.quality_class});
          continue;
        }
        await client.query(`UPDATE evidence SET verified_by=$2,verified_at=now(),tier='verified' WHERE food_item_id=$1`,[r.food_item_id,resolvedBy]);
      }
      await client.query(`UPDATE review_queue SET status=$2,resolved_by=$3,resolved_at=now() WHERE id=$1`,[id,decision,resolvedBy]);
      await A.audit(client,req,'RESOLVE_REVIEW',String(id),`BULK_${decision}`);
      results.push({id,ok:true});
    }
    await client.query('COMMIT');
    res.json({ok:true,processed:results.filter(x=>x.ok).length,results});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));


/* ---------------- V3.9 remediation planning ---------------- */

app.get('/api/review-queue/remediation-summary', A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const {rows}=await pool.query(`SELECT * FROM v_review_remediation_v39 WHERE status='PENDING' ORDER BY priority DESC, id ASC LIMIT 2000`);
  const enriched=rows.map(r=>({...r, remediation:Remediation.buildRemediation(r)}));
  enriched.sort((a,b)=>b.remediation.rank_score-a.remediation.rank_score || a.id-b.id);
  res.json({count:enriched.length, summary:Remediation.summarize(rows), items:enriched.slice(0,200), rules_version:'v3.9-remediation-1'});
}));

app.get('/api/review-queue/remediation/:id', A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const {rows}=await pool.query('SELECT * FROM v_review_remediation_v39 WHERE id=$1',[req.params.id]);
  if(!rows.length) return res.status(404).json({error:'not_found'});
  const row=rows[0];
  res.json({...row, remediation:Remediation.buildRemediation(row)});
}));

app.post('/api/review-queue/remediation/rebuild', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const limit=Math.min(Math.max(Number(req.body.limit)||2000,1),5000);
  const client=await pool.connect();
  const results=[];
  try{
    await client.query('BEGIN');
    const {rows}=await client.query(`SELECT * FROM v_review_remediation_v39 WHERE status='PENDING' ORDER BY priority DESC, id ASC LIMIT $1`,[limit]);
    for(const row of rows){
      const r=Remediation.buildRemediation(row);
      await client.query(`UPDATE review_queue
        SET remediation_action=$2, remediation_note=$3, remediation_priority=$4,
            remediation_rank=$5, remediation_generated_at=now()
        WHERE id=$1`,[row.id,r.action,r.note,r.source_priority,r.rank_score]);
      results.push({id:row.id,action:r.action,rank_score:r.rank_score});
    }
    await A.audit(client,req,'REBUILD_REMEDIATION_QUEUE',String(results.length),'V3.9');
    await client.query('COMMIT');
    res.json({ok:true,processed:results.length,results:results.slice(0,100),rules_version:'v3.9-remediation-1'});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

app.post('/api/review-queue/remediation/:id/apply-suggestion', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req,res)=>{
  const {rows}=await pool.query('SELECT * FROM v_review_remediation_v39 WHERE id=$1',[req.params.id]);
  if(!rows.length) return res.status(404).json({error:'not_found'});
  const row=rows[0];
  const suggestion=Remediation.buildRemediation(row);
  // This endpoint records a workflow decision only. It never invents nutrition values.
  if(suggestion.action === 'CLINICAL_SPOT_CHECK'){
    await A.audit(pool,req,'MARK_SPOT_CHECK',String(req.params.id),'V3.9');
    return res.json({ok:true,workflow_only:true,action:suggestion.action});
  }
  res.status(409).json({error:'manual_source_required',message:'الاقتراح لا يكتب أي قيمة غذائية تلقائيًا. يجب إدخال مصدر/قيم واعتمادها سريريًا.',suggestion});
}));

/* ---------------- Plan release gate ---------------- */

app.post('/api/plans/:id/approve', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const approvedBy = `${req.user.full_name} <${req.user.email}>`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owns = await getPlanOwner(client, req.params.id, req.user.id);
    if (!owns) { await client.query('ROLLBACK'); return res.status(404).json({ error:'not_found' }); }

    const conflicts = await client.query(`
      SELECT count(*)::int AS n
      FROM plan_item pi
      JOIN plan_day pd ON pd.id=pi.plan_day_id
      JOIN plan p ON p.id=pd.plan_id
      JOIN client cl ON cl.id=p.client_id
      LEFT JOIN food_item f ON f.id=pi.food_item_id
      LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
      LEFT JOIN evidence e ON e.food_item_id=f.id
      WHERE pd.plan_id=$1 AND (
        (pi.food_item_id IS NOT NULL AND (
          s.status <> 'COMPUTABLE' OR s.kcal IS NULL OR e.tier NOT IN ('high','verified','calculated')
          OR EXISTS (
            SELECT 1 FROM client_exclusion ce
            WHERE ce.client_id=cl.id
              AND (f.name_ar ILIKE '%'||ce.term||'%'
                OR coalesce(f.name_en,'') ILIKE '%'||ce.term||'%'
                OR EXISTS (SELECT 1 FROM food_allergen fa WHERE fa.food_item_id=f.id AND lower(fa.allergen)=lower(ce.term)))
          )
        ))
        OR (pi.custom_name IS NOT NULL AND pi.custom_kcal IS NULL)
      )`, [req.params.id]);
    if (conflicts.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error:'unresolved_plan_items', message:`Plan contains ${conflicts.rows[0].n} item(s) that are not fully computable.` });
    }

    await client.query(`UPDATE plan SET approved_by=$2, approved_at=now(), is_released=TRUE WHERE id=$1`, [req.params.id, approvedBy]);
    await A.audit(client, req, 'APPROVE_PLAN', req.params.id, approvedBy);
    await client.query('COMMIT');
    res.json({ ok:true, approved_by:approvedBy });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

app.get('/api/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok:true, database:true });
  } catch {
    res.status(503).json({ ok:false, database:false });
  }
});

// Maintenance endpoint intentionally local-only. Run a scheduler in production.
app.post('/api/admin/cleanup', A.requireCsrfHeader, A.requireRole('owner'), wrap(async (req,res)=>{
  await pool.query("DELETE FROM session WHERE expires_at < now() - interval '30 days'");
  await pool.query("DELETE FROM login_attempt WHERE attempted_at < now() - interval '30 days'");
  res.json({ok:true});
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Newtrition API v4.0 on :${port}`));
