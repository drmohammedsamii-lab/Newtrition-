#!/usr/bin/env node
'use strict';
/* Regression test for the V8.5.2 clinical-safety defect.
 *
 * Before the fix, evaluateSavedPlan() did `d.items[slot] = row`, which
 * overwrote earlier items in the same meal. The quality gate therefore only
 * ever inspected the LAST item in a slot, so an INCOMPLETE / unverified food
 * sitting earlier in the same meal was never validated and a plan containing
 * it could pass the gate and be RELEASED to a client.
 *
 * These tests drive the gate directly with multi-item slots.
 */
const Gate = require('./weekly-quality-gate');

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
};

const good = t => ({ status: 'COMPUTABLE', evidence_tier: t || 'verified',
                     kcal: 300, protein_g: 20, carb_g: 30, fat_g: 10, fiber_g: 4 });
const incomplete = () => ({ status: 'INCOMPLETE', evidence_tier: 'verified',
                            kcal: 200, protein_g: null, carb_g: 20, fat_g: 5, fiber_g: 1 });

const targets = { kcal: 1500, protein: 100, carb: 150, fat: 50, fiber: 25 };
const totals = { kcal: 1500, protein_g: 100, carb_g: 150, fat_g: 50, fiber_g: 25 };
const REQUIRED = ['فطار', 'سناك ١', 'غداء', 'سناك ٢', 'عشاء'];

function dayWith(breakfastItems) {
  const items = {};
  for (const s of REQUIRED) items[s] = [good()];
  items['فطار'] = breakfastItems;
  return { day_index: 0, day_type: 'medium', items, totals };
}

const blockerCodes = r => (r.blockers || []).map(b => b.code);

console.log('\n=== multi-item meal safety ===');

// 1. Bad item FIRST, good item LAST. This is the case the old code missed
//    entirely, because the good item overwrote the bad one.
{
  const r = Gate.evaluate({ days: [dayWith([incomplete(), good()])], targets });
  check(blockerCodes(r).includes('unresolved_items') || blockerCodes(r).includes('missing_core_macros'),
    'INCOMPLETE item FIRST in a meal is still caught (the regression case)',
    `blockers=${JSON.stringify(r.blockers)} status=${r.status}`);
  check(r.status !== 'PASS', 'plan with a hidden INCOMPLETE item does not PASS',
    `status=${r.status}`);
}

// 2. Bad item LAST — caught before and after; guards against regressing the other way.
{
  const r = Gate.evaluate({ days: [dayWith([good(), incomplete()])], targets });
  check(r.status !== 'PASS', 'INCOMPLETE item LAST in a meal is caught', `status=${r.status}`);
}

// 3. Unverified evidence tier hidden behind a verified item.
{
  const r = Gate.evaluate({ days: [dayWith([good('estimated'), good('verified')])], targets });
  check(blockerCodes(r).includes('unresolved_items'),
    'low evidence tier FIRST in a meal is still caught',
    `blockers=${JSON.stringify(r.blockers)}`);
}

// 4. A clean multi-item meal must still pass — the fix must not over-block.
{
  const r = Gate.evaluate({ days: [dayWith([good(), good(), good()])], targets });
  check(r.status === 'PASS', 'clean multi-item meal still passes (no false blocking)',
    `status=${r.status} blockers=${JSON.stringify(r.blockers)}`);
}

console.log('\n=== backward compatibility with the single-item shape ===');

// The gate must still accept the pre-V8.5.1 shape where a slot is one object.
{
  const items = {};
  for (const s of REQUIRED) items[s] = good();
  const r = Gate.evaluate({ days: [{ day_index: 0, day_type: 'medium', items, totals }], targets });
  check(r.status === 'PASS', 'legacy single-object slot shape still passes', `status=${r.status}`);
}
{
  const items = {};
  for (const s of REQUIRED) items[s] = good();
  items['غداء'] = incomplete();
  const r = Gate.evaluate({ days: [{ day_index: 0, day_type: 'medium', items, totals }], targets });
  check(r.status !== 'PASS', 'legacy single-object bad item still blocked', `status=${r.status}`);
}

console.log('\n=== empty and missing slots ===');
{
  const items = {};
  for (const s of REQUIRED) items[s] = [good()];
  items['عشاء'] = [];                       // empty array must count as missing
  const r = Gate.evaluate({ days: [{ day_index: 0, day_type: 'medium', items, totals }], targets });
  check(blockerCodes(r).includes('missing_slots'),
    'empty slot array counts as a missing slot', `blockers=${JSON.stringify(r.blockers)}`);
}

console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
process.exit(fail ? 1 : 0);
