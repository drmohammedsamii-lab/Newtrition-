'use strict';

const CORE = ['kcal','protein_g','carb_g','fat_g'];

function classifyFood(row){
  if (!row || row.is_active === false) return { class:'BLOCKED', reasons:['inactive'] };
  const missingCore = CORE.filter(k => row[k] === null || row[k] === undefined || !Number.isFinite(Number(row[k])));
  const status = String(row.status || 'INCOMPLETE');
  const evidence = String(row.evidence_tier || 'unknown').toLowerCase();
  if (status !== 'COMPUTABLE') {
    return { class:'REVIEW_REQUIRED', reasons:[`status:${status}`], missingCore };
  }
  if (missingCore.length) {
    return { class:'REVIEW_REQUIRED', reasons:['missing_core_macros'], missingCore };
  }
  if (['estimated','unknown','missing'].includes(evidence)) {
    return { class:'REVIEW_REQUIRED', reasons:[`evidence:${evidence}`] };
  }
  const warnings = [];
  if (evidence === 'calculated') warnings.push('evidence:calculated');
  if (row.fiber_g === null || row.fiber_g === undefined || !Number.isFinite(Number(row.fiber_g))) warnings.push('missing_fiber');
  if (warnings.length) return { class:'AUTO_WITH_WARNING', reasons:warnings };
  return { class:'AUTO_ELIGIBLE', reasons:[] };
}

function summarize(rows){
  const summary = {total:0,AUTO_ELIGIBLE:0,AUTO_WITH_WARNING:0,REVIEW_REQUIRED:0,BLOCKED:0};
  const reasonCounts = {};
  for (const row of rows || []) {
    const r = classifyFood(row); summary.total++; summary[r.class]++;
    for (const reason of r.reasons) reasonCounts[reason] = (reasonCounts[reason]||0)+1;
  }
  return {summary, reasonCounts};
}

module.exports = { CORE, classifyFood, summarize };
