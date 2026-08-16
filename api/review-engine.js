'use strict';

const PRIORITY = {
  CONFLICT_REVIEW: 100,
  MISSING_CORE_MACROS: 95,
  STATUS_INCOMPLETE: 90,
  EVIDENCE_LOW: 75,
  EVIDENCE_CALCULATED: 45,
  MISSING_FIBER: 30,
  OTHER: 20,
};

function priorityFor(row) {
  const status = String(row.status || 'INCOMPLETE');
  const evidence = String(row.evidence_tier || 'unknown').toLowerCase();
  const missingCore = ['kcal','protein_g','carb_g','fat_g'].filter(k => row[k] === null || row[k] === undefined || !Number.isFinite(Number(row[k])));
  if (status === 'CONFLICT_REVIEW') return PRIORITY.CONFLICT_REVIEW;
  if (missingCore.length) return PRIORITY.MISSING_CORE_MACROS;
  if (status !== 'COMPUTABLE') return PRIORITY.STATUS_INCOMPLETE;
  if (['estimated','unknown','missing'].includes(evidence)) return PRIORITY.EVIDENCE_LOW;
  if (evidence === 'calculated') return PRIORITY.EVIDENCE_CALCULATED;
  if (row.fiber_g === null || row.fiber_g === undefined || !Number.isFinite(Number(row.fiber_g))) return PRIORITY.MISSING_FIBER;
  return PRIORITY.OTHER;
}

function reasonFor(row) {
  const status = String(row.status || 'INCOMPLETE');
  const evidence = String(row.evidence_tier || 'unknown').toLowerCase();
  if (status === 'CONFLICT_REVIEW') return 'CALORIE_MACRO_CONFLICT';
  const missingCore = ['kcal','protein_g','carb_g','fat_g'].some(k => row[k] === null || row[k] === undefined || !Number.isFinite(Number(row[k])));
  if (missingCore) return 'INCOMPLETE_MACROS';
  if (status !== 'COMPUTABLE') return 'STATUS_REVIEW';
  if (['estimated','unknown','missing'].includes(evidence)) return 'EVIDENCE_REVIEW';
  if (evidence === 'calculated') return 'CALCULATED_SIGNOFF';
  if (row.fiber_g === null || row.fiber_g === undefined || !Number.isFinite(Number(row.fiber_g))) return 'INCOMPLETE_FIBER';
  return 'GENERAL_REVIEW';
}

function suggestedAction(row) {
  switch (reasonFor(row)) {
    case 'CALORIE_MACRO_CONFLICT': return 'Resolve calorie/macro conflict and confirm source.';
    case 'INCOMPLETE_MACROS': return 'Fill missing kcal/protein/carbs/fat values from a trusted source.';
    case 'STATUS_REVIEW': return 'Review nutrition status and evidence before release.';
    case 'EVIDENCE_REVIEW': return 'Replace estimated/unknown evidence or explicitly verify the current values.';
    case 'CALCULATED_SIGNOFF': return 'Clinician sign-off on calculated values.';
    case 'INCOMPLETE_FIBER': return 'Add fiber when available; otherwise keep as warning lane.';
    default: return 'Review record and confirm suitability.';
  }
}

function classify(row) {
  return { reason: reasonFor(row), priority: priorityFor(row), suggested_action: suggestedAction(row) };
}

module.exports = { PRIORITY, reasonFor, priorityFor, suggestedAction, classify };
