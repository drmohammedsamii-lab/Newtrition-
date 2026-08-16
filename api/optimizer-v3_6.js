'use strict';
const { slotBudget } = require('./nutrition-engine');
const Rules = require('./planning-rules');

const WEIGHTS = Object.freeze({
  kcal: 34, protein: 34, carb: 12, fat: 10, fiber: 4,
  repeatDay: 14, repeatWeek: 24, lowProtein: 20, portion: 6, evidence: 8
});
const MAX_PASSES = 10;

function n(v){ return v == null ? null : Number(v); }
function pctDistance(actual,target){
  if (target == null || target === 0 || actual == null) return 0;
  return Math.abs(actual-target)/Math.max(Math.abs(target),1)*100;
}
function planTotals(plan){
  const keys=['kcal','protein_g','carb_g','fat_g','fiber_g'];
  return keys.reduce((a,k)=>{
    a[k]=Object.values(plan||{}).reduce((s,c)=>s+(n(c?.[k])||0),0);
    return a;
  },{});
}
function evidencePenalty(tier){
  return ({high:0,verified:0.05,calculated:0.12,estimated:0.60,unknown:1})[String(tier||'unknown').toLowerCase()] ?? 1;
}
function scoreCandidate(c,target,usedDay=new Set(),usedWeek=new Set()){
  const kcal=n(c.kcal), protein=n(c.protein_g), carb=n(c.carb_g), fat=n(c.fat_g), fiber=n(c.fiber_g);
  let score=0;
  score += WEIGHTS.kcal*pctDistance(kcal,target.kcal)/100;
  score += WEIGHTS.protein*(protein==null?1.5:pctDistance(protein,target.protein)/100);
  score += WEIGHTS.carb*(carb==null?1.1:pctDistance(carb,target.carb)/100);
  score += WEIGHTS.fat*(fat==null?1.1:pctDistance(fat,target.fat)/100);
  score += WEIGHTS.fiber*(fiber==null?1.1:pctDistance(fiber,target.fiber)/100);
  if(protein!=null && target.protein>0 && protein<target.protein*0.5) score += WEIGHTS.lowProtein;
  if(usedDay.has(c.canonical_id)) score += WEIGHTS.repeatDay;
  if(usedWeek.has(c.canonical_id)) score += WEIGHTS.repeatWeek;
  if(target.allowedCategories && !target.allowedCategories.includes(c.category)) score += 40;
  score += WEIGHTS.portion*Rules.portionPenalty(target.slot,c.portion_grams);
  score += WEIGHTS.evidence*evidencePenalty(c.evidence_tier);
  return score;
}
function scorePlan(plan,targetTotal,usedWeekIds=new Set()){
  const t=planTotals(plan);
  let score=36*pctDistance(t.kcal,targetTotal.kcal)/100;
  score += 36*pctDistance(t.protein_g,targetTotal.protein)/100;
  score += 10*pctDistance(t.carb_g,targetTotal.carb)/100;
  score += 10*pctDistance(t.fat_g,targetTotal.fat)/100;
  score += 8*pctDistance(t.fiber_g,targetTotal.fiber)/100;
  const ids=Object.values(plan||{}).filter(Boolean).map(x=>x.canonical_id);
  const seen=new Set();
  for(const id of ids){ if(seen.has(id)) score+=14; seen.add(id); if(usedWeekIds.has(id)) score+=24; }
  return score;
}
function improvePlan(slotCandidates,plan,targetTotal,usedWeekIds=new Set()){
  let bestScore=scorePlan(plan,targetTotal,usedWeekIds);
  const slots=Object.keys(slotCandidates||{});
  for(let pass=0;pass<MAX_PASSES;pass++){
    let changed=false;
    for(const slot of slots){
      const current=plan[slot]||null;
      const dayIds=new Set(Object.values(plan).filter(Boolean).map(x=>x.canonical_id));
      if(current) dayIds.delete(current.canonical_id);
      let localBest=current, localScore=bestScore;
      for(const c of (slotCandidates[slot]||[])){
        if(!c) continue;
        if(current && c.canonical_id===current.canonical_id) continue;
        if(dayIds.has(c.canonical_id)) continue;
        const trial={...plan,[slot]:c};
        const s=scorePlan(trial,targetTotal,usedWeekIds);
        if(s<localScore-1e-9){localScore=s;localBest=c;}
      }
      if(localBest && localBest.canonical_id!==current?.canonical_id){
        plan[slot]=localBest;
        bestScore=localScore;
        changed=true;
      }
    }
    if(!changed) break;
  }
  return {plan,score:bestScore,passes:MAX_PASSES};
}
function generateDayFromCandidates({targets,dayType='medium',candidatePool,usedWeekIds=new Set()}){
  const dayTargets=Rules.adjustTargets(targets,dayType);
  const specs=slotBudget(dayTargets);
  const slotCandidates={};
  for(const spec of specs){
    const rows=(candidatePool||[]).filter(r=>spec.categories.includes(r.category));
    slotCandidates[spec.key]=rows.filter(r=>Number(r.kcal)>=spec.kcal*0.45 && Number(r.kcal)<=spec.kcal*1.60)
      .sort((a,b)=>scoreCandidate(a,{...spec,slot:spec.key},new Set(),usedWeekIds)-scoreCandidate(b,{...spec,slot:spec.key},new Set(),usedWeekIds))
      .slice(0,120);
  }
  const plan={}; const usedDay=new Set();
  for(const spec of specs){
    const target={...spec,slot:spec.key};
    const best=(slotCandidates[spec.key]||[]).slice().sort((a,b)=>scoreCandidate(a,target,usedDay,usedWeekIds)-scoreCandidate(b,target,usedDay,usedWeekIds))[0]||null;
    plan[spec.key]=best;
    if(best) usedDay.add(best.canonical_id);
  }
  const improved=improvePlan(slotCandidates,plan,{kcal:dayTargets.kcal,protein:dayTargets.protein,carb:dayTargets.carb,fat:dayTargets.fat,fiber:dayTargets.fiber},usedWeekIds);
  for(const x of Object.values(improved.plan).filter(Boolean)) usedWeekIds.add(x.canonical_id);
  return {day_type:dayType,targets:dayTargets,items:improved.plan,score:improved.score,candidateCounts:Object.fromEntries(specs.map(s=>[s.key,(slotCandidates[s.key]||[]).length]))};
}
function generateWeekFromCandidates({targets, candidatePool, carbCycling=false}){
  const sequence=Rules.dayTypeSequence({carbCycling,days:7});
  const usedWeekIds=new Set();
  const days=sequence.map((dayType,i)=>({day_index:i,...generateDayFromCandidates({targets,dayType,candidatePool,usedWeekIds}),day_name:`Day ${i+1}`}));
  return {days,quality:Rules.qualityReport({days,targets}),dayTypeSequence:sequence};
}
module.exports={
  WEIGHTS, generateDayFromCandidates, generateWeekFromCandidates,
  scoreCandidate, scorePlan, planTotals, improvePlan
};
