#!/usr/bin/env node
'use strict';
/* Newtrition V8.5.1 — full clinical workflow E2E harness.
 * Walks the real dietitian workflow through the real HTTP API. */

const BASE = 'http://127.0.0.1:3000';
const fails = [];
const passes = [];
let cookie = '';
let csrf = '';

function rec(ok, name, detail) {
  if (ok) { passes.push(name); console.log(`  PASS  ${name}`); }
  else { fails.push({ name, detail }); console.log(`  FAIL  ${name}\n        ${detail}`); }
}

async function req(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'newtrition' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  Object.assign(headers, opts.headers || {});
  const r = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of setc) {
    const kv = c.split(';')[0];
    const name = kv.split('=')[0];
    const parts = cookie ? cookie.split('; ').filter(x => !x.startsWith(name + '=')) : [];
    parts.push(kv);
    cookie = parts.join('; ');
    if (name.toLowerCase().includes('csrf')) csrf = kv.split('=').slice(1).join('=');
  }
  const ct = r.headers.get('content-type') || '';
  let data = null;
  const text = await r.text();
  if (ct.includes('json')) { try { data = JSON.parse(text); } catch { data = text; } }
  else data = text;
  return { status: r.status, data, text, headers: r.headers };
}

(async () => {
  console.log('\n=== SECTION 1: static assets & information leaks ===');
  for (const [p, expect] of [['/', 200], ['/client', 200], ['/client.html', 200],
                             ['/client-manifest.json', 200], ['/client-sw.js', 200]]) {
    const r = await req('GET', p);
    rec(r.status === expect, `GET ${p} -> ${expect}`, `got ${r.status}`);
  }
  for (const p of ['/server.js', '/package.json', '/database/schema.sql', '/auth.js', '/migrate.js']) {
    const r = await req('GET', p);
    rec(r.status === 404, `LEAK CHECK ${p} must be 404`, `got ${r.status} (source code exposed!)`);
  }
  // index.html direct
  {
    const r = await req('GET', '/index.html');
    rec(r.status === 200, 'GET /index.html -> 200', `got ${r.status} — browser refresh/bookmark on /index.html breaks`);
  }

  console.log('\n=== SECTION 1b: content library (V8.5.5) ===');
  for (const [p, needle] of [
    ['/resources', 'مكتبة'],
    ['/content/recipes.html', 'وصفات'],
    ['/content/exercise.html', 'تمارين'],
    ['/content/exchange.html', 'بدائل'],
    ['/content/faq.html', 'الأسئلة'],
  ]) {
    const r = await req('GET', p);
    rec(r.status === 200 && typeof r.text === 'string' && r.text.length > 500 && r.text.includes(needle),
        `GET ${p} serves real content unauthenticated`, `status ${r.status} len=${r.text ? r.text.length : 0}`);
  }

  console.log('\n=== SECTION 2: health & unauthenticated access ===');
  {
    const r = await req('GET', '/api/health');
    rec(r.status === 200 && r.data.ok, 'GET /api/health', JSON.stringify(r.data));
  }
  {
    const r = await req('GET', '/api/auth/me');
    rec(r.status === 401, 'GET /api/auth/me unauthenticated -> 401', `got ${r.status}`);
  }
  for (const p of ['/api/clients', '/api/dashboard', '/api/review-queue', '/api/foods?q=egg']) {
    const r = await req('GET', p);
    rec(r.status === 401, `AUTH GUARD ${p} -> 401 when logged out`, `got ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
  }

  console.log('\n=== SECTION 3: login ===');
  {
    const r = await req('POST', '/api/auth/login', { email: 'owner@newtrition.local', password: 'Owner!2345' });
    rec(r.status === 200, 'login as seeded owner', `status ${r.status} body ${JSON.stringify(r.data).slice(0,300)}`);
    if (r.status !== 200) {
      console.log('\n[!] Cannot authenticate — remaining workflow cannot be exercised.');
    }
  }
  {
    const r = await req('GET', '/api/auth/me');
    rec(r.status === 200, 'GET /api/auth/me after login', `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
  }

  console.log('\n=== SECTION 4: food catalog & search ===');
  let sampleFood = null;
  {
    const r = await req('GET', '/api/foods?limit=5');
    const items = r.data && (r.data.items || r.data.foods || r.data);
    rec(r.status === 200 && Array.isArray(items) && items.length > 0,
        'GET /api/foods returns catalog', `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    if (Array.isArray(items) && items[0]) sampleFood = items[0];
  }
  {
    const r = await req('GET', '/api/foods?q=' + encodeURIComponent('بيض') + '&limit=5');
    const items = r.data && (r.data.items || r.data);
    rec(r.status === 200 && Array.isArray(items), 'Arabic search q=بيض', `status ${r.status}`);
    if (Array.isArray(items)) console.log(`        -> ${items.length} results`);
  }
  {
    const r = await req('GET', '/api/foods?food_role=PROTEIN&limit=5');
    const items = r.data && (r.data.items || r.data);
    rec(r.status === 200, 'food_role filter accepted (UI sends this)', `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
    if (Array.isArray(items) && items.length) {
      const bad = items.filter(i => i.food_role && i.food_role !== 'PROTEIN');
      rec(bad.length === 0, 'food_role filter actually filters',
          `${bad.length}/${items.length} results have wrong role e.g. ${bad[0] && bad[0].food_role}`);
    } else {
      rec(false, 'food_role=PROTEIN returns any rows', 'zero rows — role vocabulary may not match the UI dropdown');
    }
  }
  {
    const r = await req('GET', '/api/foods?entity_type=FOOD&limit=3');
    rec(r.status === 200, 'entity_type filter accepted', `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
  }
  if (sampleFood) {
    const cid = sampleFood.canonical_id;
    const r = await req('GET', '/api/foods/' + encodeURIComponent(cid));
    rec(r.status === 200, `GET /api/foods/${cid}`, `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
    if (r.status === 200) {
      const d = r.data;
      rec(!!d.serving, 'food detail exposes .serving (UI reads full.serving.kcal)',
          `serving missing; keys=${Object.keys(d).join(',')}`);
    }
    const s = await req('GET', `/api/foods/${encodeURIComponent(cid)}/substitutes?limit=5`);
    rec(s.status === 200 && Array.isArray(s.data && s.data.substitutes),
        'GET substitutes returns {substitutes:[]}', `status ${s.status} ${JSON.stringify(s.data).slice(0,200)}`);
  }
  {
    const r = await req('GET', '/api/foods/DOES_NOT_EXIST_XYZ');
    rec(r.status === 404, 'unknown canonical id -> 404', `got ${r.status}`);
  }
  {
    const r = await req('GET', '/api/food-data/coverage');
    rec(r.status === 200, 'GET /api/food-data/coverage', `status ${r.status}`);
    if (r.status === 200) console.log('        coverage:', JSON.stringify(r.data).slice(0, 400));
  }

  console.log('\n=== SECTION 5: client creation ===');
  let clientId = null;
  {
    const r = await req('POST', '/api/clients', {
      full_name: 'مريضة اختبار', birth_year: 1992, gender: 'female',
      height_cm: 165, weight_kg: 82, activity_level: 1.375, protein_g_per_kg: 1.6, goal: 'weight_loss'
    });
    rec(r.status === 200 || r.status === 201, 'POST /api/clients creates client',
        `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    clientId = r.data && (r.data.id || (r.data.client && r.data.client.id));
  }
  {
    const r = await req('GET', '/api/clients');
    const items = r.data && (r.data.items || r.data.clients || r.data);
    rec(r.status === 200 && Array.isArray(items), 'GET /api/clients lists clients', `status ${r.status}`);
    if (!clientId && Array.isArray(items) && items[0]) clientId = items[0].id;
  }
  if (clientId) {
    const r = await req('GET', '/api/clients/' + clientId);
    rec(r.status === 200, `GET /api/clients/${clientId}`, `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
  }

  console.log('\n=== SECTION 5b: client profile completeness (V8.5.3) ===');
  if (clientId) {
    let r = await req('GET', `/api/clients/${clientId}`);
    rec(r.status === 200 && 'weight_kg' in r.data && 'activity_level' in r.data && 'protein_g_per_kg' in r.data,
        'client record exposes weight_kg / activity_level / protein_g_per_kg',
        `keys=${r.data ? Object.keys(r.data).join(',') : 'none'}`);
    rec(Number(r.data.weight_kg) === 82, 'weight_kg persisted from intake', `got ${r.data.weight_kg}`);

    r = await req('POST', `/api/clients/${clientId}/targets`,
      { kcal: 1600, protein: 110, carb: 150, fat: 55, fiber: 25, bmr: 1400, tdee: 1900 });
    rec(r.status === 200, 'POST targets snapshot', `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);

    r = await req('GET', '/api/clients');
    const found = (r.data.items || []).find(c => c.id === clientId);
    rec(!!found && !!found.computed_targets && Number(found.computed_targets.kcal) === 1600,
        'GET /api/clients list includes the saved targets snapshot',
        `found=${JSON.stringify(found && found.computed_targets)}`);

    r = await req('POST', `/api/clients/${clientId}/profile`, { weight_kg: 79 });
    rec(r.status === 200 && Number(r.data.weight_kg) === 79,
        'POST /api/clients/:id/profile updates a single field', `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
  }
  {
    // A client registered with a name only must not silently pretend to have targets.
    const r = await req('POST', '/api/clients', { full_name: 'عميلة بيانات ناقصة' });
    rec(r.status === 201 && r.data.weight_kg == null,
        'client created without weight has weight_kg=null, not a default', `got ${JSON.stringify(r.data).slice(0,200)}`);
  }

  console.log('\n=== SECTION 6: clinical suggestion engine ===');
  if (clientId) {
    const r = await req('GET', `/api/suggest?client_id=${clientId}&slot=` + encodeURIComponent('فطار') + '&kcal=400');
    rec(r.status === 200, 'GET /api/suggest with client', `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    if (r.status === 200) {
      const items = r.data.candidates || r.data.items || r.data.suggestions || [];
      console.log(`        -> ${Array.isArray(items) ? items.length : '?'} candidates`);
      rec(Array.isArray(items) && items.length > 0, 'suggest returns candidates',
          `empty candidate pool: ${JSON.stringify(r.data).slice(0,300)}`);
    }
  }
  {
    const r = await req('GET', '/api/suggest');
    rec(r.status >= 400, 'suggest without client -> explicit error not 500',
        `status ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);
    rec(r.status !== 500, 'suggest missing params must not 500', `got 500: ${JSON.stringify(r.data).slice(0,200)}`);
  }

  console.log('\n=== SECTION 7: plan persistence (the Save Draft path the UI uses) ===');
  let planId = null;
  // Pull five COMPUTABLE, well-evidenced foods so a realistic full day can be built.
  let pool5 = [];
  {
    const r = await req('GET', '/api/foods?limit=60');
    const items = (r.data && r.data.items) || [];
    pool5 = items.filter(i => i.kcal != null && i.protein_g != null && i.carb_g != null && i.fat_g != null).slice(0, 6);
    rec(pool5.length >= 5, 'catalog yields >=5 fully-computable foods for a day plan',
        `only ${pool5.length} usable`);
  }
  const SLOTS = ['فطار','سناك ١','غداء','سناك ٢','عشاء'];
  if (clientId && pool5.length >= 5) {
    const items = SLOTS.map((slot, i) => ({ canonical_id: pool5[i].canonical_id, slot, qty: 1, is_locked: false }));
    // second item in فطار: a real multi-item meal, plus a fractional quantity
    items.push({ canonical_id: pool5[5] ? pool5[5].canonical_id : pool5[0].canonical_id, slot: 'فطار', qty: 0.5, is_locked: false });
    const r = await req('POST', `/api/clients/${clientId}/plans`, {
      label: 'خطة يوم كامل', targets: { kcal: 1600, protein: 110, carb: 150, fat: 55, fiber: 25 },
      days: [{ day_index: 0, day_name: 'اليوم 1', items }]
    });
    rec(r.status === 201, 'POST full-day plan (5 slots, multi-item breakfast, fractional qty)',
        `status ${r.status} ${JSON.stringify(r.data).slice(0,400)}`);
    planId = r.data && r.data.plan_id;
    rec(r.data && r.data.version !== undefined, 'response includes .version (UI alerts r.version)',
        `keys=${r.data ? Object.keys(r.data).join(',') : 'none'}`);
  }
  if (planId) {
    const r = await req('GET', `/api/plans/${planId}`);
    rec(r.status === 200, `GET /api/plans/${planId}`, `status ${r.status}`);
    if (r.status === 200) {
      const its = r.data.items || [];
      const breakfast = its.filter(i => i.slot === 'فطار');
      rec(breakfast.length === 2, 'multi-item breakfast survived the round-trip',
          `expected 2 items in فطار, got ${breakfast.length} — multi-item meals are being collapsed`);
      rec(breakfast.some(i => Number(i.qty) === 0.5), 'fractional qty 0.5 persisted',
          `qty values: ${JSON.stringify(breakfast.map(i => i.qty))}`);
      rec(its.length === 6, 'all six plan items persisted', `got ${its.length}`);
    }
  }

  console.log('\n=== SECTION 8: plan lifecycle DRAFT -> IN_REVIEW -> APPROVED -> RELEASED ===');
  if (planId) {
    let r = await req('POST', `/api/plans/${planId}/approve`);
    rec(r.status >= 400, 'approve DRAFT directly must be rejected (lifecycle guard)',
        `got ${r.status} — a DRAFT was approved without review`);
    r = await req('POST', `/api/plans/${planId}/release`);
    rec(r.status >= 400, 'release DRAFT directly must be rejected',
        `got ${r.status} — an unapproved plan was released to a client`);
    r = await req('POST', `/api/plans/${planId}/submit`);
    rec(r.status === 200, 'submit plan for review', `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    r = await req('GET', `/api/plans/${planId}/quality`);
    rec(r.status === 200, 'GET plan quality gate', `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    if (r.status === 200) console.log('        quality:', JSON.stringify(r.data).slice(0, 300));
    r = await req('POST', `/api/plans/${planId}/approve`);
    rec(r.status === 200, 'approve plan after review', `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    r = await req('POST', `/api/plans/${planId}/release`);
    rec(r.status === 200, 'release plan to client', `status ${r.status} ${JSON.stringify(r.data).slice(0,400)}`);
  }

  console.log('\n=== SECTION 9: constraints / allergens ===');
  if (clientId) {
    let r = await req('GET', `/api/clients/${clientId}/constraints`);
    rec(r.status === 200, 'GET client constraints', `status ${r.status}`);
    r = await req('POST', `/api/clients/${clientId}/constraints`, { kind: 'allergen', constraint_key: 'egg', value: 'egg', severity: 'HARD' });
    rec(r.status === 200 || r.status === 201, 'POST allergy constraint',
        `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    r = await req('GET', `/api/suggest?client_id=${clientId}&slot=` + encodeURIComponent('فطار') + '&kcal=400');
    if (r.status === 200) {
      const items = r.data.candidates || r.data.items || r.data.suggestions || [];
      const leaked = (Array.isArray(items) ? items : []).filter(i =>
        /egg|بيض/i.test((i.name_ar || '') + ' ' + (i.name_en || '')));
      rec(leaked.length === 0, 'SAFETY: egg-allergic client gets no egg suggestions',
          `${leaked.length} egg items leaked through the eligibility engine: ${leaked.slice(0,3).map(i=>i.name_ar).join(' | ')}`);
    }
  }

  console.log('\n=== SECTION 10: dashboard / review queue / saas ===');
  for (const p of ['/api/dashboard', '/api/review-queue', '/api/saas/me']) {
    const r = await req('GET', p);
    rec(r.status === 200, `GET ${p}`, `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
  }
  if (clientId) {
    for (const p of [`/api/clients/${clientId}/followup-intelligence`,
                     `/api/clients/${clientId}/decision-workspace`,
                     `/api/clients/${clientId}/ai-context`,
                     `/api/clients/${clientId}/logs`]) {
      const r = await req('GET', p);
      rec(r.status === 200, `GET ${p}`, `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
    }
  }

  console.log('\n=== SECTION 11: client portal account + client login ===');
  if (clientId) {
    const r = await req('POST', `/api/clients/${clientId}/account`, { email: 'client.test@example.com', password: 'ClientPass!234' });
    rec(r.status === 200 || r.status === 201, 'create client portal account',
        `status ${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
  }

  console.log('\n=== SECTION 12: malformed input robustness (must be 4xx, never 500) ===');
  const badCases = [
    ['POST', '/api/clients', { full_name: '' }],
    ['POST', '/api/clients', { full_name: 'X', height_cm: 'abc', weight_kg: -5, birth_year: 3000 }],
    ['GET', '/api/foods?limit=99999', undefined],
    ['GET', '/api/foods?limit=-1', undefined],
    ['GET', "/api/foods?q=' OR 1=1--", undefined],
    ['GET', '/api/plans/999999999', undefined],
    ['GET', '/api/clients/notanumber', undefined],
    ['POST', '/api/clients/1/plans', { days: 'nope' }],
  ];
  for (const [m, p, b] of badCases) {
    const r = await req(m, p, b);
    rec(r.status !== 500, `${m} ${p} must not 500`, `got 500: ${JSON.stringify(r.data).slice(0,200)}`);
  }

  console.log('\n\n================ SUMMARY ================');
  console.log(`PASS: ${passes.length}   FAIL: ${fails.length}`);
  if (fails.length) {
    console.log('\nFAILURES:');
    fails.forEach((f, i) => console.log(`${i + 1}. ${f.name}\n   ${f.detail}`));
  }
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
