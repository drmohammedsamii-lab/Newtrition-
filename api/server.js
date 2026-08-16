/**
 * Newtrition API — Phase 3
 * Serves the canonical nutrition catalog and the clinical review queue.
 *
 * Run:  DATABASE_URL=postgres://user:pass@host/newtrition node server.js
 * Deps: npm install express pg
 */
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const APP_VERSION = require('./package.json').version;
const A = require('./auth');
const ClientAuth = require('./client-auth');
const ClinicalConstraints = require('./clinical-constraints');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Basic hardening. The app ships no third-party scripts, so the policy can be strict.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  next();
});

app.use((req,res,next)=>{ if(req.path.startsWith('/api/')) { res.setHeader('Cache-Control','no-store'); } next(); });

app.use(express.static(path.join(__dirname, 'public')));   // login page + app shell
app.get('/client', (req,res)=>res.sendFile(path.join(__dirname,'public','client.html')));
app.use(A.attachUser(pool));
app.use(ClientAuth.attachClient(pool));

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  const status = Number(err?.status) || 500;
  res.status(status).json({ error: err?.code || 'internal_error' });
});

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
  // One message for every failure mode, so the response cannot be used to
  // discover which email addresses have accounts.
  const deny = () => res.status(401).json({ error: 'invalid_credentials',
    message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });

  if (!email || !password) return deny();

  if (await A.tooManyFailures(pool, email, ip)) {
    await A.recordAttempt(pool, email, ip, false);
    return res.status(429).json({ error: 'too_many_attempts',
      message: 'محاولات كتيرة. استني ١٥ دقيقة وحاول تاني' });
  }

  const { rows } = await pool.query(
    'SELECT id, email, full_name, role, password_hash, is_active FROM clinician WHERE lower(email) = lower($1)',
    [email]);
  const u = rows[0];

  if (!u || !u.is_active ? !A.verifyPassword(password, A.DUMMY_PASSWORD_HASH) : !A.verifyPassword(password, u.password_hash)) {
    await A.recordAttempt(pool, email, ip, false);
    return deny();
  }

  await A.recordAttempt(pool, email, ip, true);
  await pool.query('UPDATE clinician SET last_login_at = now() WHERE id = $1', [u.id]);
  const { token, expires } = await A.createSession(pool, u.id, req);
  A.setSessionCookie(res, token, expires);
  req.user = u;                       // spreading req would drop its headers
  await A.audit(pool, req, 'LOGIN', u.email);
  res.json({ id: u.id, email: u.email, full_name: u.full_name, role: u.role });
}));

app.post('/api/auth/logout', A.requireCsrfHeader, wrap(async (req, res) => {
  await A.revokeSession(pool, req.cookies?.[A.COOKIE]);
  A.clearSessionCookie(res);
  res.json({ ok: true });
}));

// Only an owner may create accounts. There is no open registration.
app.post('/api/auth/users', A.requireCsrfHeader, A.requireRole('owner'), wrap(async (req, res) => {
  const { email, full_name, password, role = 'clinician' } = req.body;
  if (!email || !full_name) return res.status(400).json({ error: 'email_and_name_required' });
  const problem = A.passwordProblem(password);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
  if (!['owner','clinician','assistant'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO clinician (email, full_name, password_hash, role, organization_id)
       SELECT $1,$2,$3,$4,organization_id FROM clinician WHERE id=$5
       RETURNING id, email, full_name, role, organization_id`,
      [email.trim(), full_name.trim(), A.hashPassword(password), role, req.user.id]);
    await A.audit(pool, req, 'CREATE_USER', email);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    throw e;
  }
}));

app.post('/api/auth/password', A.requireCsrfHeader, A.requireAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body;
  const problem = A.passwordProblem(new_password);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });

  const { rows } = await pool.query('SELECT password_hash FROM clinician WHERE id = $1', [req.user.id]);
  if (!A.verifyPassword(current_password || '', rows[0].password_hash))
    return res.status(401).json({ error: 'wrong_password', message: 'كلمة المرور الحالية غير صحيحة' });

  await pool.query('UPDATE clinician SET password_hash = $2 WHERE id = $1',
    [req.user.id, A.hashPassword(new_password)]);
  // Changing a password ends every other session, including a stolen one.
  await pool.query(`UPDATE session SET revoked_at = now()
                    WHERE clinician_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
    [req.user.id, require('crypto').createHash('sha256').update(req.cookies[A.COOKIE]).digest('hex')]);
  await A.audit(pool, req, 'CHANGE_PASSWORD', req.user.email);
  res.json({ ok: true });
}));

/* ---------------- Client portal authentication ---------------- */
/* Separate cookie, separate throttle bucket, shorter session. A client
   account can only ever read her own released plan and her own logs —
   never another client's data, never a draft, never edit access. */

app.get('/api/client-auth/me', (req, res) => {
  if (!req.clientUser) return res.status(401).json({ error: 'auth_required' });
  const { account_id, email, full_name, must_change_password } = req.clientUser;
  res.json({ id: account_id, email, full_name, must_change_password });
});

app.post('/api/client-auth/login', ClientAuth.csrf, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const ip = A.clientIp(req);
  const deny = () => res.status(401).json({ error: 'invalid_credentials',
    message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });

  if (!email || !password) return deny();
  if (await A.tooManyFailures(pool, email, ip)) {
    await A.recordAttempt(pool, email, ip, false);
    return res.status(429).json({ error: 'too_many_attempts',
      message: 'محاولات كتيرة. استني ١٥ دقيقة وحاول تاني' });
  }

  const { rows } = await pool.query(`
    SELECT ca.id, ca.email, ca.password_hash, ca.is_active, ca.must_change_password,
           c.full_name
    FROM client_account ca JOIN client c ON c.id = ca.client_id
    WHERE lower(ca.email) = lower($1)`, [email]);
  const u = rows[0];

  if (!u || !u.is_active ? !A.verifyPassword(password, A.DUMMY_PASSWORD_HASH) : !A.verifyPassword(password, u.password_hash)) {
    await A.recordAttempt(pool, email, ip, false);
    return deny();
  }

  await A.recordAttempt(pool, email, ip, true);
  await pool.query('UPDATE client_account SET last_login_at = now() WHERE id = $1', [u.id]);
  const { token, expires } = await ClientAuth.createSession(pool, u.id, u.client_id, req);
  ClientAuth.setSessionCookie(res, token, expires);
  res.json({ id: u.id, email: u.email, full_name: u.full_name,
             must_change_password: u.must_change_password });
}));

app.post('/api/client-auth/logout', ClientAuth.csrf, wrap(async (req, res) => {
  await ClientAuth.revokeSession(pool, req.clientCookies?.[ClientAuth.COOKIE]);
  ClientAuth.clearSessionCookie(res);
  res.json({ ok: true });
}));

// A client must set her own password on first login; the clinician-issued
// one is a one-time credential, never the permanent one.
app.post('/api/client-auth/password', ClientAuth.csrf, ClientAuth.requireClientAuth, wrap(async (req, res) => {
  const { current_password, new_password } = req.body;
  const problem = A.passwordProblem(new_password);
  if (problem) return res.status(400).json({ error: 'weak_password', message: problem });

  const { rows } = await pool.query('SELECT password_hash FROM client_account WHERE id = $1',
    [req.clientUser.account_id]);
  if (!A.verifyPassword(current_password || '', rows[0].password_hash))
    return res.status(401).json({ error: 'wrong_password', message: 'كلمة المرور الحالية غير صحيحة' });

  await pool.query(
    'UPDATE client_account SET password_hash = $2, must_change_password = FALSE WHERE id = $1',
    [req.clientUser.account_id, A.hashPassword(new_password)]);
  await pool.query(`UPDATE session SET revoked_at = now()
                    WHERE client_account_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
    [req.clientUser.account_id,
     require('crypto').createHash('sha256').update(req.clientCookies[ClientAuth.COOKIE]).digest('hex')]);
  res.json({ ok: true });
}));

/* Everything under /api/client (data, not auth) requires a signed-in client. */
app.use('/api/client', ClientAuth.requireClientAuth);

app.get('/api/client/plan', wrap(async (req, res) => {
  const clientId = req.clientUser.client_id;
  const plan = (await pool.query(
    `SELECT * FROM v_client_visible_plan WHERE client_id = $1
     ORDER BY version DESC LIMIT 1`, [clientId])).rows[0];
  if (!plan) return res.json({ plan: null });

  const { rows: days } = await pool.query(
    'SELECT id, day_index, day_name, day_type FROM plan_day WHERE plan_id = $1 ORDER BY day_index',
    [plan.plan_id]);
  const { rows: items } = await pool.query(`
    SELECT pi.id, pi.plan_day_id, pi.slot, pi.qty, pi.position,
           coalesce(f.name_ar, pi.custom_name) AS name_ar, f.name_en, f.food_role, f.portion_label,
           coalesce(s.kcal, pi.custom_kcal)     AS kcal,
           s.protein_g, s.carb_g, s.fat_g, s.fiber_g
    FROM plan_item pi
    JOIN plan_day pd            ON pd.id = pi.plan_day_id
    LEFT JOIN food_item f       ON f.id = pi.food_item_id
    LEFT JOIN nutrition_serving s ON s.food_item_id = f.id
    WHERE pd.plan_id = $1
    ORDER BY pd.day_index, pi.position`, [plan.plan_id]);

  res.json({ plan, days, items });
}));

app.get('/api/client/logs', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT log_date, weight_kg, water_ml, steps, note FROM daily_log
     WHERE client_id = $1 ORDER BY log_date DESC LIMIT 60`, [req.clientUser.client_id]);
  res.json({ items: rows });
}));

// One row per day: logging today again updates today, it does not duplicate.
app.post('/api/client/logs', ClientAuth.csrf, wrap(async (req, res) => {
  const { log_date, weight_kg, water_ml, steps, note } = req.body;
  if (!log_date) return res.status(400).json({ error: 'log_date_required' });
  const { rows } = await pool.query(`
    INSERT INTO daily_log (client_id, log_date, weight_kg, water_ml, steps, note)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (client_id, log_date) DO UPDATE
      SET weight_kg = excluded.weight_kg, water_ml = excluded.water_ml,
          steps = excluded.steps, note = excluded.note
    RETURNING *`, [req.clientUser.client_id, log_date, weight_kg, water_ml, steps, note]);
  res.status(201).json(rows[0]);
}));

app.post('/api/client/checkin', ClientAuth.csrf, wrap(async (req, res) => {
  const { plan_item_id, log_date, eaten = true } = req.body;
  if (!plan_item_id || !log_date) return res.status(400).json({ error: 'plan_item_id_and_log_date_required' });

  // A client may only check in against an item on her own released plan.
  const owns = await pool.query(`
    SELECT 1 FROM plan_item pi
    JOIN plan_day pd ON pd.id = pi.plan_day_id
    JOIN v_client_visible_plan v ON v.plan_id = pd.plan_id
    WHERE pi.id = $1 AND v.client_id = $2`, [plan_item_id, req.clientUser.client_id]);
  if (!owns.rows.length) return res.status(404).json({ error: 'not_found' });

  await pool.query(`
    INSERT INTO meal_checkin (client_id, plan_item_id, log_date, eaten)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (client_id, plan_item_id, log_date) DO UPDATE SET eaten = excluded.eaten`,
    [req.clientUser.client_id, plan_item_id, log_date, eaten]);
  res.status(201).json({ ok: true });
}));

app.get('/api/client/checkins', wrap(async (req, res) => {
  const { date } = req.query;
  const { rows } = await pool.query(`
    SELECT plan_item_id, eaten FROM meal_checkin
    WHERE client_id = $1 AND log_date = $2`, [req.clientUser.client_id, date || new Date().toISOString().slice(0,10)]);
  res.json({ items: rows });
}));

app.get('/api/client/followups', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT visit_date, weight_kg, waist_cm, body_fat_pct, adherence_pct, notes
    FROM followup WHERE client_id=$1 ORDER BY visit_date DESC LIMIT 60`, [req.clientUser.client_id]);
  res.json({items: rows});
}));

app.post('/api/client/followups', ClientAuth.csrf, wrap(async (req,res)=>{
  const {visit_date,weight_kg,waist_cm,body_fat_pct,adherence_pct,notes}=req.body;
  if(!visit_date) return res.status(400).json({error:'visit_date_required'});
  const {rows} = await pool.query(`INSERT INTO followup(client_id,visit_date,weight_kg,waist_cm,body_fat_pct,adherence_pct,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.clientUser.client_id,visit_date,weight_kg||null,waist_cm||null,body_fat_pct||null,adherence_pct||null,notes||null]);
  res.status(201).json(rows[0]);
}));

/* Everything past this point requires a signed-in clinician. */
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/client-auth/') || req.path.startsWith('/client/')) return next();
  return A.requireAuth(req, res, next);
});

/* ---------------- Data coverage ---------------- */

app.get('/api/food-data/coverage', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM v_food_data_coverage');
  res.json(rows[0] || {});
}));

/* ---------------- Catalog ---------------- */

// Bilingual search. Returns only what is safe to suggest unless ?includeReview=1
app.get('/api/foods', wrap(async (req, res) => {
  const { q = '', category, entity_type, limit = 50, offset = 0, includeReview } = req.query;
  const table = includeReview === '1' ? 'food_item_full' : 'v_optimizer_eligible';

  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(name_ar ILIKE $${params.length} OR coalesce(name_en,'') ILIKE $${params.length})`);
  }
  if (category)    { params.push(category);    where.push(`category = $${params.length}`); }
  if (entity_type) { params.push(entity_type); where.push(`entity_type = $${params.length}`); }

  params.push(Math.min(Number(limit) || 50, 200));
  params.push(Number(offset) || 0);

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
           to_jsonb(e) - 'food_item_id' AS evidence
    FROM food_item f
    LEFT JOIN nutrition_serving s ON s.food_item_id = f.id
    LEFT JOIN nutrition_per100   p ON p.food_item_id = f.id
    LEFT JOIN evidence           e ON e.food_item_id = f.id
    WHERE f.canonical_id = $1`, [req.params.canonicalId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
}));

/* ---------------- Substitution ----------------
   Nutritional similarity, not calorie proximity alone.
   Weights mirror the V11 engine: kcal fit, protein fit, same role, evidence.  */

app.get('/api/foods/:canonicalId/substitutes', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 30);
  const { rows } = await pool.query('SELECT * FROM find_substitutes($1, $2)',
                                    [req.params.canonicalId, limit]);
  res.json({ substitutes: rows });
}));

/* ---------------- Plan building ---------------- */

app.get('/api/clients', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, gender, birth_year, height_cm, goal
     FROM client WHERE clinician_id = $1 ORDER BY id DESC`, [req.user.id]);
  res.json({ items: rows });
}));

app.post('/api/clients', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const { full_name, gender, birth_year, height_cm, goal } = req.body;
  if (!full_name) return res.status(400).json({ error: 'full_name_required' });
  const { rows } = await pool.query(`INSERT INTO client
      (clinician_id, organization_id, full_name, gender, birth_year, height_cm, goal)
      SELECT $1, organization_id, $2, $3, $4, $5, $6
      FROM clinician WHERE id=$1
      RETURNING *`,
    [req.user.id, full_name, gender, birth_year, height_cm, goal]);
  if (!rows.length) return res.status(409).json({error:'clinician_not_found'});
  await A.audit(pool, req, 'CREATE_CLIENT', String(rows[0].id));
  res.status(201).json(rows[0]);
}));

app.get('/api/clients/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM client WHERE id = $1 AND clinician_id = $2', [req.params.id, req.user.id]);
  // Not found and not yours are answered identically, so ids cannot be probed.
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
}));

// Suggest items for one slot. Returns candidates for a clinician to choose from —
// it deliberately does not auto-commit anything to a plan.
/* Suggest items for one slot. Clinical path only: client_id is required so
   the same eligibility engine used by the weekly optimizer is applied here.
   The legacy text-only exclusion path is intentionally retired. */
app.get('/api/suggest', wrap(async (req, res) => {
  const clientId = Number(req.query.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0)
    return res.status(400).json({ error: 'client_id_required' });
  if (!await assertOwnsClient(clientId, req.user.id))
    return res.status(404).json({ error: 'not_found' });

  const kcal = Number(req.query.kcal) || 500;
  const protein = Number(req.query.protein) || 0;
  const role = req.query.role || null;

  const { rows: constraintRows } = await pool.query(
    'SELECT kind, constraint_key, value, severity, source FROM client_constraint WHERE client_id=$1', [clientId]);
  const constraints = ClinicalConstraints.splitConstraints(constraintRows);

  const { rows } = await pool.query(`
    SELECT * FROM v_food_candidate_intelligence
    WHERE status='COMPUTABLE'
      AND kcal IS NOT NULL AND protein_g IS NOT NULL AND carb_g IS NOT NULL AND fat_g IS NOT NULL
      ${role ? 'AND food_role = $2' : ''}
    ORDER BY abs(kcal - $1)/GREATEST($1,1) + abs(protein_g - $3)/GREATEST($3,1)
    LIMIT $4`, [kcal, role, protein, 120]);

  const candidates = rows
    .map(c => ({ c, verdict: ClinicalConstraints.evaluateCandidate(c, constraints) }))
    .filter(x => x.verdict.eligible)
    .map(x => ({ ...x.c, distance: Math.round((Math.abs(Number(x.c.kcal)-kcal)/Math.max(kcal,1)*100 + Math.abs(Number(x.c.protein_g)-protein)/Math.max(protein,1)*50 + (x.verdict.softPenalty||0))*10)/10 }))
    .sort((a,b) => a.distance-b.distance)
    .slice(0,20);

  res.json({ candidates });
}));

/* ---------------- Plan persistence ---------------- */

// Every plan read/write is joined back to the signed-in clinician, so a plan id
// belonging to someone else behaves exactly like one that does not exist.
async function assertOwnsClient(clientId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM client c
     JOIN clinician cl ON cl.id = c.clinician_id
     WHERE c.id=$1 AND c.clinician_id=$2 AND (cl.organization_id IS NOT DISTINCT FROM (SELECT organization_id FROM clinician WHERE id=$2))`,
    [clientId, userId]);
  return rows.length > 0;
}
async function assertOwnsPlan(planId, userId) {
  const { rows } = await pool.query(
    'SELECT client_id FROM v_plan_owner WHERE plan_id = $1 AND clinician_id = $2', [planId, userId]);
  return rows[0] || null;
}

app.get('/api/clients/:id/plans', wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id))
    return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    `SELECT id, version, label, target_kcal, target_protein_g,
            approved_by, approved_at, is_released, created_at, updated_at,
            workflow_status, quality_score, quality_status
     FROM plan WHERE client_id = $1 ORDER BY version DESC`, [req.params.id]);
  res.json({ items: rows });
}));

app.get('/api/plans/:id', wrap(async (req, res) => {
  const own = await assertOwnsPlan(req.params.id, req.user.id);
  if (!own) return res.status(404).json({ error: 'not_found' });

  const plan = (await pool.query('SELECT * FROM plan WHERE id = $1', [req.params.id])).rows[0];
  const { rows: days } = await pool.query(
    'SELECT * FROM plan_day WHERE plan_id = $1 ORDER BY day_index', [req.params.id]);
  const { rows: items } = await pool.query(`
    SELECT pi.*, f.canonical_id, f.name_ar, f.name_en, f.food_role, f.portion_label,
           s.kcal, s.protein_g, s.carb_g, s.fat_g, s.fiber_g, e.tier AS evidence_tier
    FROM plan_item pi
    JOIN plan_day pd            ON pd.id = pi.plan_day_id
    LEFT JOIN food_item f       ON f.id = pi.food_item_id
    LEFT JOIN nutrition_serving s ON s.food_item_id = f.id
    LEFT JOIN evidence e        ON e.food_item_id = f.id
    WHERE pd.plan_id = $1
    ORDER BY pd.day_index, pi.position`, [req.params.id]);

  res.json({ plan, days, items });
}));

// Saving always writes a new version. Nothing is overwritten, so a released
// plan a client is following cannot change under her.
app.post('/api/clients/:id/plans', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const clientId = req.params.id;
  if (!await assertOwnsClient(clientId, req.user.id))
    return res.status(404).json({ error: 'not_found' });

  const { label, targets = {}, days = [], notes } = req.body;
  if (!Array.isArray(days) || !days.length || days.length > 7)
    return res.status(400).json({ error: 'days_required' });
  const seenDays = new Set();
  for (const [i, day] of days.entries()) {
    const di = day.day_index ?? i;
    if (!Number.isInteger(di) || di < 0 || di > 6 || seenDays.has(di))
      return res.status(400).json({error:'invalid_day_index'});
    seenDays.add(di);
    for (const it of (day.items || [])) {
      if (it.canonical_id && it.custom_name) return res.status(400).json({error:'food_and_custom_cannot_both_be_set'});
      if (it.custom_name && [it.custom_kcal,it.custom_protein_g,it.custom_carb_g,it.custom_fat_g].some(v => v == null))
        return res.status(400).json({error:'custom_item_requires_core_nutrition'});
      if (!it.canonical_id && !it.custom_name) return res.status(400).json({error:'plan_item_reference_required'});
    }
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [{ next_version }] } = await db.query(
      'SELECT coalesce(max(version),0)+1 AS next_version FROM plan WHERE client_id = $1', [clientId]);

    const { rows: [plan] } = await db.query(`
      INSERT INTO plan (client_id, version, label, notes,
                        target_kcal, target_protein_g, target_carb_g, target_fat_g, target_fiber_g)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [clientId, next_version, label || `خطة ${next_version}`, notes || null,
       targets.kcal, targets.protein, targets.carb, targets.fat, targets.fiber]);

    for (const [i, day] of days.entries()) {
      const { rows: [pd] } = await db.query(
        `INSERT INTO plan_day (plan_id, day_index, day_name, day_type)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [plan.id, day.day_index ?? i, day.day_name || `اليوم ${i + 1}`, day.day_type || null]);

      for (const [j, it] of (day.items || []).entries()) {
        let foodId = null;
        if (it.canonical_id) {
          const f = await db.query('SELECT id FROM food_item WHERE canonical_id = $1', [it.canonical_id]);
          foodId = f.rows[0]?.id || null;
        }
        if (it.canonical_id && !foodId) throw Object.assign(new Error('food_not_found'), {status:400, code:'FOOD_NOT_FOUND'});
        await db.query(`
          INSERT INTO plan_item (plan_day_id, food_item_id, slot, qty, is_locked,
                                 custom_name, custom_kcal, custom_protein_g, custom_carb_g, custom_fat_g, custom_fiber_g, position)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [pd.id, foodId, it.slot || 'رئيسية', it.qty || 1, !!it.is_locked,
           foodId ? null : it.custom_name, foodId ? null : it.custom_kcal,
           foodId ? null : it.custom_protein_g, foodId ? null : it.custom_carb_g,
           foodId ? null : it.custom_fat_g, foodId ? null : it.custom_fiber_g, j]);
      }
    }

    await db.query('COMMIT');
    const quality = await evaluateSavedPlan(plan.id);
    await A.audit(pool, req, 'SAVE_PLAN', String(plan.id), `v${next_version} for client ${clientId}`);
    res.status(201).json({ plan_id: plan.id, version: next_version, quality });
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}));

// Releasing v3 retires whatever the client was following before.
app.post('/api/plans/:id/approve', A.requireCsrfHeader, A.requireRole('owner','clinician'),
  wrap(async (req, res) => {
  const own = await assertOwnsPlan(req.params.id, req.user.id);
  if (!own) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(`
    SELECT workflow_status, quality_status, quality_blockers
    FROM plan WHERE id=$1`, [req.params.id]);
  const plan = rows[0];
  if (!plan) return res.status(404).json({ error:'not_found' });
  if (plan.workflow_status !== 'IN_REVIEW') return res.status(409).json({ error:'not_in_review' });
  if (plan.quality_status !== 'PASS') return res.status(409).json({ error:'quality_gate_not_passed', blockers: plan.quality_blockers });
  const reviewedBy = `${req.user.full_name} <${req.user.email}>`;
  const result = await pool.query(`
    UPDATE plan SET workflow_status='APPROVED', reviewed_by=$2, reviewed_at=now(), updated_at=now()
    WHERE id=$1 AND workflow_status='IN_REVIEW' AND quality_status='PASS'
    RETURNING id, workflow_status, reviewed_by, reviewed_at`, [req.params.id, reviewedBy]);
  await A.audit(pool, req, 'APPROVE_PLAN', req.params.id, reviewedBy);
  res.json(result.rows[0]);
}));

app.post('/api/plans/:id/release', A.requireCsrfHeader, A.requireRole('owner','clinician'),
  wrap(async (req, res) => {
  const own = await assertOwnsPlan(req.params.id, req.user.id);
  if (!own) return res.status(404).json({ error: 'not_found' });

  const conflicts = await pool.query(`
    SELECT count(*)::int AS n
    FROM plan_item pi
    JOIN plan_day pd ON pd.id = pi.plan_day_id
    LEFT JOIN nutrition_serving s ON s.food_item_id = pi.food_item_id
    WHERE pd.plan_id = $1
      AND (
        (pi.food_item_id IS NOT NULL AND (s.status <> 'COMPUTABLE' OR s.kcal IS NULL OR s.protein_g IS NULL OR s.carb_g IS NULL OR s.fat_g IS NULL))
        OR
        (pi.food_item_id IS NULL AND (pi.custom_name IS NULL OR pi.custom_kcal IS NULL OR pi.custom_protein_g IS NULL OR pi.custom_carb_g IS NULL OR pi.custom_fat_g IS NULL))
      )`, [req.params.id]);
  if (conflicts.rows[0].n > 0)
    return res.status(409).json({ error: 'unreviewed_items',
      message: `الخطة فيها ${conflicts.rows[0].n} صنف بيانات غير معتمدة. راجعها قبل الإصدار.` });

  // An empty plan (e.g. every candidate excluded by a fail-safe allergen
  // check because the catalog has no structured data for this client's
  // constraint) must never reach a client silently. Same for a plan the
  // quality gate itself marked BLOCKED — that status exists specifically
  // to stop this.
  const itemCount = await pool.query(`
    SELECT count(*)::int AS n FROM plan_item pi
    JOIN plan_day pd ON pd.id = pi.plan_day_id WHERE pd.plan_id = $1`, [req.params.id]);
  if (itemCount.rows[0].n === 0)
    return res.status(409).json({ error: 'empty_plan',
      message: 'الخطة فارغة تمامًا — لا يمكن إصدارها. راجعي قيود العميلة أو أضيفي أصناف يدويًا.' });

  await evaluateSavedPlan(req.params.id);
  const planRow = (await pool.query('SELECT workflow_status, quality_status FROM plan WHERE id=$1', [req.params.id])).rows[0];
  if (!planRow) return res.status(404).json({error:'not_found'});
  if (planRow.workflow_status !== 'APPROVED')
    return res.status(409).json({ error: 'plan_not_approved', message: 'لا يمكن إصدار الخطة قبل اعتمادها رسميًا.' });
  if (planRow.quality_status !== 'PASS')
    return res.status(409).json({ error: 'quality_gate_not_passed', message: 'بوابة الجودة لم تعتمد الخطة.' });

  const approved_by = `${req.user.full_name} <${req.user.email}>`;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`UPDATE plan SET superseded_by = $1
                    WHERE client_id = $2 AND id <> $1 AND is_released AND superseded_by IS NULL`,
      [req.params.id, own.client_id]);
    await db.query(`UPDATE plan SET approved_by = $2, approved_at = now(),
                    is_released = TRUE, updated_at = now() WHERE id = $1`,
      [req.params.id, approved_by]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }

  await A.audit(pool, req, 'RELEASE_PLAN', req.params.id, approved_by);
  res.json({ ok: true, approved_by });
}));

/* ---------------- Client accounts (created by the clinician) ---------------- */

app.post('/api/clients/:id/account', A.requireCsrfHeader, A.requireRole('owner','clinician'),
  wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id))
    return res.status(404).json({ error: 'not_found' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email_required' });

  // A generated temporary password is the default path: the clinician hands
  // it to the client out-of-band, and the client is forced to replace it on
  // first login (must_change_password). A clinician-chosen password is also
  // accepted if given explicitly.
  const temp = req.body.password || randomPassword();
  if (!req.body.password) {
    const problem = A.passwordProblem(temp);
    if (problem) return res.status(500).json({ error: 'password_generation_failed' });
  } else {
    const problem = A.passwordProblem(temp);
    if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO client_account (client_id, email, password_hash, must_change_password)
      VALUES ($1,$2,$3, TRUE) RETURNING id, email`,
      [req.params.id, email.trim(), A.hashPassword(temp)]);
    await A.audit(pool, req, 'CREATE_CLIENT_ACCOUNT', email);
    // The plaintext password is returned exactly once, here, and never stored.
    res.status(201).json({ ...rows[0], temporary_password: temp });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    throw e;
  }
}));

// The clinician's view of what the client has been logging.
app.get('/api/clients/:id/logs', wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id))
    return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(`
    SELECT d.log_date, d.weight_kg, d.water_ml, d.steps, d.note,
           a.eaten, a.logged
    FROM daily_log d
    LEFT JOIN v_adherence a ON a.client_id = d.client_id AND a.log_date = d.log_date
    WHERE d.client_id = $1 ORDER BY d.log_date DESC LIMIT 90`, [req.params.id]);
  res.json({ items: rows });
}));

/* ---------------- Clinical review queue (human-in-the-loop) ---------------- */

app.get('/api/review-queue', wrap(async (req, res) => {
  const { status = 'PENDING' } = req.query;
  const { rows } = await pool.query(`
    SELECT rq.id, rq.reason, rq.detail, rq.status,
           f.canonical_id, f.name_ar, f.name_en, f.brand,
           s.kcal, s.protein_g, s.carb_g, s.fat_g, s.kcal_from_macros,
           COALESCE((SELECT array_agg(fa.allergen||':'||fa.confidence) FROM food_allergen fa
                     WHERE fa.food_item_id=f.id), ARRAY[]::text[]) AS allergen_tags
    FROM review_queue rq
    JOIN food_item f          ON f.id = rq.food_item_id
    JOIN nutrition_serving s  ON s.food_item_id = f.id
    WHERE rq.status = $1
    ORDER BY (rq.reason='ALLERGEN_PROFILE_REVIEW') DESC,
             abs(coalesce(s.kcal,0) - s.kcal_from_macros) DESC`, [status]);
  res.json({ count: rows.length, items: rows });
}));

// Fast path: confirm many inferred allergen profiles at once when a clinician
// has eyeballed a batch and found no missing allergens to add. Anything that
// needs an addition still goes through the per-item resolve endpoint above,
// since add_allergens is item-specific.
app.post('/api/review-queue/bulk-verify-allergens', A.requireCsrfHeader, A.requireRole('owner','clinician'),
  wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids_required' });
  const resolved_by = `${req.user.full_name} <${req.user.email}>`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT id, food_item_id FROM review_queue
      WHERE id = ANY($1) AND reason='ALLERGEN_PROFILE_REVIEW' AND status='PENDING'`, [ids]);
    for (const r of rows) {
      await client.query(`
        UPDATE food_item SET allergen_profile_status='VERIFIED',
               allergen_profile_reviewed_by=$2, allergen_profile_reviewed_at=now()
        WHERE id=$1`, [r.food_item_id, resolved_by]);
      await client.query(`
        UPDATE review_queue SET status='APPROVED', resolved_by=$2, resolved_at=now()
        WHERE id=$1`, [r.id, resolved_by]);
    }
    await client.query('COMMIT');
    await A.audit(pool, req, 'BULK_VERIFY_ALLERGENS', null, `${rows.length} items`);
    res.json({ verified: rows.length });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// A clinician resolves an item. Nothing else may change nutrition values.
// Branches by reason: nutrition corrections touch nutrition_serving/evidence;
// allergen-profile reviews touch food_item.allergen_profile_status instead —
// approving one must never silently also alter the other.
app.post('/api/review-queue/:id/resolve', A.requireCsrfHeader, A.requireRole('owner','clinician'),
  wrap(async (req, res) => {
  const { kcal, protein_g, carb_g, fat_g, fiber_g, decision, add_allergens = [] } = req.body;
  if (!Array.isArray(add_allergens)) return res.status(400).json({error:'add_allergens_must_be_array'});
  const allowedAllergens = new Set(['milk','egg','peanut','tree_nut','soy','wheat','gluten','fish','shellfish','sesame']);
  if (add_allergens.some(a => !allowedAllergens.has(String(a).trim().toLowerCase())))
    return res.status(400).json({error:'invalid_allergen'});
  // The name on the record is the signed-in account, never a value the client sends.
  const resolved_by = `${req.user.full_name} <${req.user.email}>`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query('SELECT food_item_id, reason FROM review_queue WHERE id = $1', [req.params.id]);
    if (!q.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    const { food_item_id: foodId, reason } = q.rows[0];

    if (decision === 'APPROVED' && reason === 'ALLERGEN_PROFILE_REVIEW') {
      // The clinician can add anything the inference missed before signing off —
      // this is the moment a genuinely complete profile gets recorded.
      for (const a of add_allergens) {
        await client.query(`
          INSERT INTO food_allergen (food_item_id, allergen, confidence, source_ref)
          VALUES ($1,$2,'clinician_added',$3)
          ON CONFLICT (food_item_id, allergen) DO UPDATE SET confidence='clinician_added'`,
          [foodId, a, resolved_by]);
      }
      await client.query(`
        UPDATE food_item SET allergen_profile_status='VERIFIED',
               allergen_profile_reviewed_by=$2, allergen_profile_reviewed_at=now()
        WHERE id=$1`, [foodId, resolved_by]);
    } else if (decision === 'APPROVED') {
      const current = (await client.query(`SELECT kcal, protein_g, carb_g, fat_g, fiber_g FROM nutrition_serving WHERE food_item_id=$1 FOR UPDATE`, [foodId])).rows[0];
      if (!current) { await client.query('ROLLBACK'); return res.status(409).json({error:'nutrition_missing'}); }
      const next = {
        kcal: kcal ?? current.kcal, protein_g: protein_g ?? current.protein_g,
        carb_g: carb_g ?? current.carb_g, fat_g: fat_g ?? current.fat_g, fiber_g: fiber_g ?? current.fiber_g
      };
      const core = [next.kcal,next.protein_g,next.carb_g,next.fat_g];
      if (core.some(v => v === null || v === undefined || Number(v) < 0)) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'incomplete_core_nutrition', message:'لا يمكن اعتماد الصنف كبيانات قابلة للحساب قبل اكتمال السعرات والبروتين والكارب والدهون.'});
      }
      await client.query(`
        UPDATE nutrition_serving
        SET kcal=$2, protein_g=$3, carb_g=$4, fat_g=$5, fiber_g=$6, status='COMPUTABLE'
        WHERE food_item_id=$1`, [foodId, next.kcal, next.protein_g, next.carb_g, next.fat_g, next.fiber_g]);
      await client.query(`
        UPDATE evidence SET verified_by = $2, verified_at = now(), tier = 'verified'
        WHERE food_item_id = $1`, [foodId, resolved_by]);
    }

    await client.query(`
      UPDATE review_queue SET status = $2, resolved_by = $3, resolved_at = now()
      WHERE id = $1`, [req.params.id, decision || 'APPROVED', resolved_by]);

    await client.query('COMMIT');
    await A.audit(pool, req, 'RESOLVE_REVIEW', req.params.id, decision || 'APPROVED');
    res.json({ ok: true, resolved_by });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

/* Plan release lives with the rest of plan persistence, above
   ("POST /api/plans/:id/release") — it supersedes any prior released
   version for the same client, which a bare "approve" flag cannot express. */

/* ================================================================
   Phase 8 merge — ported from the external V8.0 package after fixing
   three verified bugs (see chat record):
     1. server crashed on boot (ClientAuth.A.* — wrong export shape)
     2. optimizer threw "could not determine data type of parameter $3"
        (clientId bound but never referenced in the SQL)
     3. a HARD allergen constraint did not block a matching food, because
        the catalog has zero rows in food_allergen/food_ingredient and
        "no data" was silently treated as "safe" — fixed to fail safe.
   Every endpoint below was exercised against a live database before
   being included here.
   ================================================================ */

const Optimizer   = require('./optimizer');
const QualityGate = require('./weekly-quality-gate');
const Repair       = require('./repair-engine');
const Explain      = require('./explainability');
const FollowupIntel = require('./followup-intelligence');
const DecisionWS   = require('./decision-workspace');
const AIContext    = require('./ai-context');
const AIAssistant  = require('./ai-assistant');
const AICopilot    = require('./ai-planning-copilot');
const NutritionEngine = require('./nutrition-engine');

/* ---------------- SaaS identity ---------------- */

app.get('/api/saas/me', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.id, o.name, o.slug,
           s.plan_code, s.status AS subscription_status, s.current_period_end
    FROM clinician c
    LEFT JOIN organization o ON o.id = c.organization_id
    LEFT JOIN subscription s ON s.organization_id = o.id
      AND s.status IN ('TRIAL','ACTIVE','PAST_DUE','PAUSED')
    WHERE c.id = $1`, [req.user.id]);
  res.json(rows[0] || { organization: null });
}));

/* ---------------- Client constraints (allergies, diet, preferences) ---------------- */

app.get('/api/clients/:id/constraints', wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    'SELECT id, kind, constraint_key, value, severity, source FROM client_constraint WHERE client_id=$1 ORDER BY kind, id',
    [req.params.id]);
  res.json({ items: rows });
}));

app.post('/api/clients/:id/constraints', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  const { kind, constraint_key, value, severity = 'HARD' } = req.body;
  if (!kind || !constraint_key || !value) return res.status(400).json({ error: 'kind_key_value_required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO client_constraint (client_id, kind, constraint_key, value, severity, source)
      VALUES ($1,$2,$3,$4,$5,'clinician') RETURNING *`,
      [req.params.id, kind, constraint_key, value, severity]);
    await A.audit(pool, req, 'ADD_CONSTRAINT', req.params.id, `${kind}:${value}`);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'constraint_exists' });
    throw e;
  }
}));

app.delete('/api/clients/:id/constraints/:constraintId', A.requireCsrfHeader, wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM client_constraint WHERE id=$1 AND client_id=$2', [req.params.constraintId, req.params.id]);
  res.json({ ok: true });
}));

/* ---------------- Follow-up intelligence & decision workspace ---------------- */

app.get('/api/clients/:id/followup-intelligence', wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  // followup-intelligence.js expects plain 'YYYY-MM-DD' strings. node-pg
  // returns DATE columns as JS Date objects, which silently broke every
  // trend/age calculation (String(dateObj) does not round-trip through
  // 'T00:00:00Z' parsing — it produced Invalid Date, then NaN, then a
  // JSON `null` with no error). to_char() avoids that class of bug entirely.
  const { rows } = await pool.query(
    `SELECT id, to_char(visit_date,'YYYY-MM-DD') AS visit_date,
            weight_kg, waist_cm, body_fat_pct, adherence_pct
     FROM followup WHERE client_id=$1 ORDER BY visit_date`, [req.params.id]);
  res.json(FollowupIntel.analyze(rows));
}));

app.get('/api/clients/:id/decision-workspace', wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  const { rows: fu } = await pool.query(
    `SELECT id, to_char(visit_date,'YYYY-MM-DD') AS visit_date,
            weight_kg, waist_cm, body_fat_pct, adherence_pct
     FROM followup WHERE client_id=$1 ORDER BY visit_date`, [req.params.id]);
  const intelligence = FollowupIntel.analyze(fu);
  const { rows: [latestPlan] } = await pool.query(
    'SELECT id, workflow_status, is_released, quality_status FROM plan WHERE client_id=$1 ORDER BY version DESC LIMIT 1', [req.params.id]);
  const conflicts = await pool.query(`
    SELECT count(*)::int AS n FROM review_queue rq
    JOIN food_item f ON f.id = rq.food_item_id
    WHERE rq.status='PENDING'`);
  const ws = DecisionWS.build({ intelligence, progress: {}, latestPlan, conflictingReviewItems: 0 });
  res.json(ws);
}));

function randomPassword(){ return require('crypto').randomBytes(12).toString('base64url') + 'A1'; }

async function buildServerAIContext(clientId){
  const client=(await pool.query('SELECT * FROM client WHERE id=$1',[clientId])).rows[0];
  const constraints=(await pool.query('SELECT kind AS type, value, severity, source FROM client_constraint WHERE client_id=$1',[clientId])).rows;
  const latestPlan=(await pool.query('SELECT * FROM plan WHERE client_id=$1 ORDER BY version DESC LIMIT 1',[clientId])).rows[0];
  return AIContext.build({client,constraints,latestPlan});
}

async function evaluateSavedPlan(planId){
  const plan=(await pool.query('SELECT * FROM plan WHERE id=$1',[planId])).rows[0];
  if(!plan) return null;
  const client=(await pool.query('SELECT * FROM client WHERE id=$1',[plan.client_id])).rows[0];
  const constraintRows=(await pool.query('SELECT kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1',[plan.client_id])).rows;
  const constraints=ClinicalConstraints.splitConstraints(constraintRows);
  const {rows:days}=await pool.query('SELECT id,day_index,day_type FROM plan_day WHERE plan_id=$1 ORDER BY day_index',[planId]);
  const {rows:items}=await pool.query(`
    SELECT pi.plan_day_id,pi.slot,pi.qty,pi.food_item_id,pi.custom_name,pi.custom_kcal,pi.custom_protein_g,pi.custom_carb_g,pi.custom_fat_g,pi.custom_fiber_g,
           f.canonical_id,s.kcal,s.protein_g,s.carb_g,s.fat_g,s.fiber_g,s.status,
           e.tier AS evidence_tier
    FROM plan_item pi
    JOIN plan_day pd ON pd.id=pi.plan_day_id
    LEFT JOIN food_item f ON f.id=pi.food_item_id
    LEFT JOIN nutrition_serving s ON s.food_item_id=f.id
    LEFT JOIN LATERAL (
      SELECT tier FROM evidence ev WHERE ev.food_item_id=f.id ORDER BY CASE ev.tier WHEN 'verified' THEN 1 WHEN 'high' THEN 2 WHEN 'calculated' THEN 3 WHEN 'estimated' THEN 4 ELSE 5 END, ev.verified_at DESC NULLS LAST, ev.id DESC LIMIT 1
    ) e ON TRUE
    WHERE pd.plan_id=$1 ORDER BY pd.day_index,pi.position`,[planId]);

  const canonicalIds=items.map(x=>x.canonical_id).filter(Boolean);
  const candidateMap=new Map();
  if(canonicalIds.length){
    const {rows:cands}=await pool.query('SELECT * FROM v_food_candidate_intelligence WHERE canonical_id = ANY($1::text[])',[canonicalIds]);
    for(const c of cands) candidateMap.set(c.canonical_id,c);
  }
  const safetyBlockers=[];
  const byDay=new Map(days.map(d=>[d.id,{day_index:d.day_index,day_type:d.day_type,items:{},totals:{kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0}}]));
  for(const it of items){
    const d=byDay.get(it.plan_day_id); if(!d) continue;
    const qty=Number(it.qty||1);
    const custom=it.food_item_id==null;
    if(custom){
      safetyBlockers.push(`custom_item_requires_review:${it.custom_name||'unnamed'}`);
    } else {
      const c=candidateMap.get(it.canonical_id);
      if(!c) safetyBlockers.push(`food_missing_candidate:${it.canonical_id}`);
      else {
        const verdict=ClinicalConstraints.evaluateCandidate(c,constraints);
        if(!verdict.eligible) safetyBlockers.push(`${it.canonical_id}:${verdict.reason}`);
      }
    }
    const row={
      canonical_id:it.canonical_id,status:custom?'CUSTOM':it.status,evidence_tier:custom?'unknown':(it.evidence_tier||'unknown'),
      kcal:custom?Number(it.custom_kcal):Number(it.kcal),
      protein_g:custom?Number(it.custom_protein_g):Number(it.protein_g),
      carb_g:custom?Number(it.custom_carb_g):Number(it.carb_g),
      fat_g:custom?Number(it.custom_fat_g):Number(it.fat_g),
      fiber_g:custom?Number(it.custom_fiber_g||0):Number(it.fiber_g||0)
    };
    d.items[it.slot]=row;
    for(const k of Object.keys(d.totals)) d.totals[k]+=Number(row[k]||0)*qty;
  }
  const result=QualityGate.evaluate({days:[...byDay.values()],targets:{kcal:plan.target_kcal,protein:plan.target_protein_g,carb:plan.target_carb_g,fat:plan.target_fat_g,fiber:plan.target_fiber_g}});
  const blockers=[...new Set([...(result.blockers||[]),...safetyBlockers])];
  const status=blockers.length?'BLOCKED':result.status;
  await pool.query('UPDATE plan SET quality_score=$2,quality_status=$3,quality_blockers=$4,quality_warnings=$5,updated_at=now() WHERE id=$1',[planId,result.score,status,JSON.stringify(blockers),JSON.stringify(result.warnings||[])]);
  return {...result,status,blockers};
}

/* ---------------- Dashboard ---------------- */

app.get('/api/dashboard', wrap(async (req, res) => {
  const { rows: clients } = await pool.query(
    'SELECT id, full_name FROM client WHERE clinician_id=$1', [req.user.id]);
  const { rows: planCounts } = await pool.query(`
    SELECT c.id AS client_id, p.workflow_status, count(*)::int AS n
    FROM plan p JOIN client c ON c.id = p.client_id
    WHERE c.clinician_id = $1
    GROUP BY c.id, p.workflow_status`, [req.user.id]);
  const { rows: overdue } = await pool.query(`
    SELECT c.id AS client_id, c.full_name,
           max(f.visit_date) AS last_visit,
           (CURRENT_DATE - max(f.visit_date)) AS days_since
    FROM client c LEFT JOIN followup f ON f.client_id = c.id
    WHERE c.clinician_id = $1
    GROUP BY c.id, c.full_name
    HAVING max(f.visit_date) IS NULL OR (CURRENT_DATE - max(f.visit_date)) > 13
    ORDER BY days_since DESC NULLS FIRST`, [req.user.id]);

  const byClient = {};
  for (const row of planCounts) {
    byClient[row.client_id] = byClient[row.client_id] || {};
    byClient[row.client_id][row.workflow_status] = row.n;
  }
  res.json({
    total_clients: clients.length,
    plans_by_client: byClient,
    followup_due_or_overdue: overdue,
    generated_at: new Date().toISOString()
  });
}));

/* ---------------- AI context / assistant / planning copilot ---------------- */

app.get('/api/clients/:id/ai-context', wrap(async (req, res) => {
  if (!await assertOwnsClient(req.params.id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  const client = (await pool.query('SELECT * FROM client WHERE id=$1', [req.params.id])).rows[0];
  const constraints = (await pool.query(
    'SELECT kind AS type, value, severity, source FROM client_constraint WHERE client_id=$1', [req.params.id])).rows;
  const latestPlan = (await pool.query(
    'SELECT * FROM plan WHERE client_id=$1 ORDER BY version DESC LIMIT 1', [req.params.id])).rows[0];
  res.json(AIContext.build({ client, constraints, latestPlan }));
}));

app.post('/api/ai/assistant', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const { client_id, task } = req.body;
  if (!client_id || !task) return res.status(400).json({ error: 'client_id_and_task_required' });
  if (!await assertOwnsClient(client_id, req.user.id)) return res.status(404).json({ error: 'not_found' });
  const context = await buildServerAIContext(client_id);
  try {
    const result = await AIAssistant.assist({ task, context });
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));

app.post('/api/ai/planning-copilot', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const { task } = req.body;
  try {
    const result = await AICopilot.parse({ task });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}));

// AI proposes structured intent -> the deterministic optimizer builds the
// actual plan -> saved as a DRAFT. The AI never writes nutrition values itself.
app.post('/api/clients/:id/plans/from-ai', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const clientId = req.params.id;
  if (!await assertOwnsClient(clientId, req.user.id)) return res.status(404).json({ error: 'not_found' });
  const { task } = req.body;
  let ai;
  try { ai = await AICopilot.parse({ task }); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  if (!ai.ready) return res.status(422).json({ error: 'intent_incomplete', errors: ai.errors, intent: ai.intent });

  const i = ai.intent;
  const targets = { kcal: i.target_kcal, protein: i.target_protein_g, carb: i.target_carb_g,
                     fat: i.target_fat_g, fiber: i.target_fiber_g };
  const week = await Optimizer.generateWeek(pool, {
    targets, clientId, days: i.days, mealCount: i.meals_per_day,
    carbCycling: i.carb_cycling, allowWarnings: i.allow_warnings,
    extraConstraints: i.constraints
  });

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [{ next_version }] } = await db.query(
      'SELECT coalesce(max(version),0)+1 AS next_version FROM plan WHERE client_id=$1', [clientId]);
    const { rows: [plan] } = await db.query(`
      INSERT INTO plan (client_id, version, label, target_kcal, target_protein_g, target_carb_g,
                        target_fat_g, target_fiber_g, workflow_status, ai_intent,
                        quality_score, quality_status, quality_blockers, quality_warnings, optimizer_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,'v6.6-ai-planning-copilot-1')
      RETURNING *`,
      [clientId, next_version, `مقترح AI — ${task.slice(0,40)}`, targets.kcal, targets.protein,
       targets.carb, targets.fat, targets.fiber, JSON.stringify(i),
       week.quality.score, week.quality.blockers.length ? 'BLOCKED' : 'PASS',
       JSON.stringify(week.quality.blockers), JSON.stringify(week.quality.warnings)]);

    for (const day of week.days) {
      const { rows: [pd] } = await db.query(
        `INSERT INTO plan_day (plan_id, day_index, day_name, day_type) VALUES ($1,$2,$3,$4) RETURNING id`,
        [plan.id, day.day_index, day.day_name, day.day_type]);
      let pos = 0;
      for (const [slot, item] of Object.entries(day.items)) {
        if (!item) continue;
        const f = await db.query('SELECT id FROM food_item WHERE canonical_id=$1', [item.canonical_id]);
        if (!f.rows[0]) continue;
        await db.query(`
          INSERT INTO plan_item (plan_day_id, food_item_id, slot, qty, position)
          VALUES ($1,$2,$3,1,$4)`, [pd.id, f.rows[0].id, slot, pos++]);
      }
    }
    await db.query('COMMIT');
    await A.audit(pool, req, 'AI_DRAFT_PLAN', String(plan.id), task.slice(0, 100));
    res.status(201).json({ plan_id: plan.id, version: next_version, quality: week.quality, intent: i });
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}));

/* ---------------- Quality gate / explainability on a saved plan ---------------- */

app.get('/api/plans/:id/quality', wrap(async (req, res) => {
  const own = await assertOwnsPlan(req.params.id, req.user.id);
  if (!own) return res.status(404).json({ error: 'not_found' });
  const plan = (await pool.query('SELECT * FROM plan WHERE id=$1', [req.params.id])).rows[0];
  res.json({
    quality_score: plan.quality_score, quality_status: plan.quality_status,
    quality_blockers: plan.quality_blockers, quality_warnings: plan.quality_warnings,
    workflow_status: plan.workflow_status
  });
}));

/* ---------------- Workflow: DRAFT -> IN_REVIEW -> APPROVED ---------------- */

app.post('/api/plans/:id/submit', A.requireCsrfHeader, A.requireRole('owner','clinician'), wrap(async (req, res) => {
  const own = await assertOwnsPlan(req.params.id, req.user.id);
  if (!own) return res.status(404).json({ error: 'not_found' });
  const current = (await pool.query('SELECT workflow_status, quality_status FROM plan WHERE id=$1',[req.params.id])).rows[0];
  if (!current) return res.status(404).json({error:'not_found'});
  if (current.workflow_status !== 'DRAFT') return res.status(409).json({error:'not_in_draft'});
  if (current.quality_status !== 'PASS') return res.status(409).json({error:'quality_gate_not_passed'});
  const { rows } = await pool.query(`
    UPDATE plan SET workflow_status='IN_REVIEW', submitted_by=$2, submitted_at=now()
    WHERE id=$1 AND workflow_status='DRAFT' AND quality_status='PASS' RETURNING id, workflow_status`,
    [req.params.id, `${req.user.full_name} <${req.user.email}>`]);
  if (!rows.length) return res.status(409).json({ error: 'not_in_draft' });
  res.json(rows[0]);
}));

app.get('/api/health', (_, res) => res.json({ ok: true, app: 'Newtrition', version: APP_VERSION }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Newtrition API v${APP_VERSION} on :${port}`));
