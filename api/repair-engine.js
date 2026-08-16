'use strict';

/**
 * V5.1 Repair Engine
 *
 * Safety rule: this module never invents nutrition values. It only evaluates
 * replacement weeks produced by the existing eligible-data optimizer and
 * selects a candidate that improves the Quality Gate result.
 */

function finite(v){ return Number.isFinite(Number(v)); }

function errorMagnitude(report){
  const checks = Array.isArray(report?.targetChecks) ? report.targetChecks : [];
  return checks.reduce((sum,c)=>sum + (finite(c.relativeError) ? Number(c.relativeError) : 1), 0);
}

function objective(report){
  if(!report) return Number.POSITIVE_INFINITY;
  const blockers = Array.isArray(report.blockers) ? report.blockers.length : 999;
  const warnings = Array.isArray(report.warnings) ? report.warnings.length : 999;
  const score = finite(report.score) ? Number(report.score) : 0;
  return blockers * 100000 + warnings * 1000 + errorMagnitude(report) * 100 - score;
}

function compareReports(a,b){
  return objective(a) - objective(b);
}

function summarizeRepair(original, candidate, attempts){
  return {
    original_status: original?.status || 'UNKNOWN',
    original_score: original?.score ?? null,
    original_blockers: original?.blockers?.length || 0,
    original_warnings: original?.warnings?.length || 0,
    repaired_status: candidate?.status || 'UNKNOWN',
    repaired_score: candidate?.score ?? null,
    repaired_blockers: candidate?.blockers?.length || 0,
    repaired_warnings: candidate?.warnings?.length || 0,
    attempts,
    improved: compareReports(candidate, original) < 0
  };
}

/**
 * Pick the best week from generator attempts. The callback receives
 * {allowWarnings, attempt}. The generator must return a week object with
 * `quality` produced by the same Quality Gate used for approval.
 */
async function repairWeek({initial, generateCandidate, maxAttempts=3}={}){
  if(!initial?.quality) throw new Error('initial_quality_required');
  const attempts=[];
  let best=initial;

  for(let i=1;i<=Math.max(1,maxAttempts);i++){
    if(best.quality?.ok) break;
    const candidate = await generateCandidate({
      attempt:i,
      allowWarnings:i>1,
      current:best
    });
    if(!candidate?.quality){
      attempts.push({attempt:i, status:'NO_QUALITY'});
      continue;
    }
    attempts.push({attempt:i, status:candidate.quality.status, score:candidate.quality.score,
      blockers:candidate.quality.blockers?.length||0, warnings:candidate.quality.warnings?.length||0});
    if(compareReports(candidate.quality,best.quality)<0) best=candidate;
  }

  return {
    repaired: best !== initial,
    accepted: Boolean(best.quality?.ok),
    result: best,
    summary: summarizeRepair(initial.quality,best.quality,attempts),
    attempts
  };
}

function canReplaceItem(item){ return !item?.is_locked; }

function firstReplaceableSlot(day){
  const entries=Object.entries(day?.items||{});
  for(const [slot,item] of entries){ if(canReplaceItem(item)) return slot; }
  return null;
}

module.exports={
  objective, compareReports, summarizeRepair, repairWeek, canReplaceItem, firstReplaceableSlot
};
