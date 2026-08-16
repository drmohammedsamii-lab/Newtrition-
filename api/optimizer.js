'use strict';
const { slotBudget } = require('./nutrition-engine');
const Rules = require('./planning-rules');
const Constraints = require('./clinical-constraints');
const PortionEngine = require('./portion-engine');

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
  if(c.constraint_penalty) score += Number(c.constraint_penalty);
  if(c.portion_score != null) score += (1-Number(c.portion_score))*2;
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

function duplicateIds(plan){
  const counts=new Map();
  for(const item of Object.values(plan||{}).filter(Boolean)) counts.set(item.canonical_id,(counts.get(item.canonical_id)||0)+1);
  return [...counts.entries()].filter(([,n])=>n>1).map(([id,count])=>({id,count}));
}
function weekMetrics(week,targetTotal){
  const ids=[]; const totals={kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0}; const dayScores=[];
  for(const d of week||[]){
    const t=d.totals||planTotals(d.items);
    for(const k of Object.keys(totals)) totals[k]+=Number(t[k]||0);
    dayScores.push(scorePlan(d.items||{},targetTotal,new Set()));
    for(const item of Object.values(d.items||{}).filter(Boolean)) ids.push(item.canonical_id);
  }
  const freq=new Map(); ids.forEach(id=>freq.set(id,(freq.get(id)||0)+1));
  const repeated=[...freq.entries()].filter(([,n])=>n>1);
  return {days:week?.length||0,totals,averagePerDay:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,(week?.length||0)?v/week.length:0])),averageDayScore:dayScores.length?dayScores.reduce((a,b)=>a+b,0)/dayScores.length:0,repeatedItems:repeated.map(([id,count])=>({id,count})),uniqueItems:freq.size,itemCount:ids.length,repeatCount:repeated.reduce((a,[,n])=>a+(n-1),0)};
}
function testPickBest(candidates,targetOrKcal,proteinOrUsed,usedDayOrWeek,maybeUsedWeek){
  // Backward-compatible helper for existing regression tests.
  let target, usedDay, usedWeek;
  if(typeof targetOrKcal==='number'){
    target={kcal:targetOrKcal,protein:Number(proteinOrUsed)||0,carb:0,fat:0,fiber:0,allowedCategories:null,slot:'غداء'};
    usedDay=usedDayOrWeek||new Set(); usedWeek=maybeUsedWeek||new Set();
  }else{
    target=targetOrKcal||{}; usedDay=proteinOrUsed||new Set(); usedWeek=usedDayOrWeek||new Set();
  }
  return (candidates||[]).slice().sort((a,b)=>scoreCandidate(a,target,usedDay,usedWeek)-scoreCandidate(b,target,usedDay,usedWeek))[0]||null;
}
async function queryCandidates(pool, spec, clientId, limit=180, allowWarnings=false, constraintState=null){
  const sql=`
    SELECT v.canonical_id,v.name_ar,v.name_en,v.category,v.entity_type,v.food_role,
           v.kcal,v.protein_g,v.carb_g,v.fat_g,v.fiber_g,v.evidence_tier,v.status,f.portion_grams,
           COALESCE((SELECT array_agg(fa.allergen ORDER BY fa.allergen) FROM food_allergen fa WHERE fa.food_item_id=v.id), ARRAY[]::text[]) AS allergens,
           COALESCE((SELECT array_agg(fi.ingredient_name ORDER BY fi.ingredient_name) FROM food_ingredient fi WHERE fi.food_item_id=v.id), ARRAY[]::text[]) AS ingredients,
           COALESCE((SELECT array_agg(dt.tag ORDER BY dt.tag) FROM food_diet_tag dt WHERE dt.food_item_id=v.id), ARRAY[]::text[]) AS diet_tags,
           COALESCE((SELECT array_agg(po.label ORDER BY po.is_default DESC, po.id) FROM portion_option po WHERE po.food_item_id=v.id), ARRAY[]::text[]) AS portion_options
    FROM ${allowWarnings ? 'v_optimizer_eligible_with_warning' : 'v_optimizer_eligible_strict'} v JOIN food_item f ON f.id=v.id
    WHERE v.kcal BETWEEN $1*0.40 AND $1*1.70
      AND v.category = ANY($2::text[])
    ORDER BY abs(v.kcal-$1)/GREATEST($1,1)*100,
             CASE WHEN v.protein_g IS NULL THEN 999 ELSE abs(v.protein_g-$3)/GREATEST($3,1)*100 END,
             v.name_ar LIMIT $4`;
  const {rows}=await pool.query(sql,[spec.kcal,spec.categories,spec.protein||0,limit]);
  if(!constraintState) return rows;
  return rows.map(r=>({r,check:Constraints.evaluateCandidate(r,constraintState),portion:PortionEngine.scorePortion(r,spec.key)}))
    .filter(x=>x.check.eligible)
    .map(x=>({...x.r, constraint_penalty:x.check.softPenalty||0, portion_score:x.portion.score}));
}

async function generateDay({targets,clientId,dayType='medium',candidatePool,usedWeekIds=new Set(),pool,allowWarnings=false,constraintState=null,mealCount=5}){
  if(!candidatePool){
    const dayTargets=Rules.adjustTargets(targets,dayType);
    const specs=slotBudget(dayTargets,{meal_count:mealCount});
    candidatePool=[];
    for(const spec of specs) candidatePool.push(...await queryCandidates(pool,spec,clientId,180,allowWarnings,constraintState));
  }
  const rows=candidatePool;
  const dayTargets=Rules.adjustTargets(targets,dayType);
  const specs=slotBudget(dayTargets,{meal_count:mealCount});
  const slotCandidates={};
  for(const spec of specs){
    slotCandidates[spec.key]=rows.filter(r=>spec.categories.includes(r.category) && Number(r.kcal)>=spec.kcal*0.45 && Number(r.kcal)<=spec.kcal*1.60)
      .sort((a,b)=>scoreCandidate(a,{...spec,slot:spec.key},new Set(),usedWeekIds)-scoreCandidate(b,{...spec,slot:spec.key},new Set(),usedWeekIds)).slice(0,120);
  }
  const plan={}; const usedDay=new Set();
  for(const spec of specs){
    const target={...spec,slot:spec.key};
    const best=(slotCandidates[spec.key]||[]).slice().sort((a,b)=>scoreCandidate(a,target,usedDay,usedWeekIds)-scoreCandidate(b,target,usedDay,usedWeekIds))[0]||null;
    plan[spec.key]=best; if(best) usedDay.add(best.canonical_id);
  }
  const improved=improvePlan(slotCandidates,plan,{kcal:dayTargets.kcal,protein:dayTargets.protein,carb:dayTargets.carb,fat:dayTargets.fat,fiber:dayTargets.fiber},usedWeekIds);
  for(const x of Object.values(improved.plan).filter(Boolean)) usedWeekIds.add(x.canonical_id);
  return {day_type:dayType,targets:dayTargets,items:improved.plan,score:improved.score,candidateCounts:Object.fromEntries(specs.map(s=>[s.key,(slotCandidates[s.key]||[]).length]))};
}

async function generateWeek(pool,{targets,clientId,days=7,carbCycling=false,dayTypeSequence:requestedSequence,allowWarnings=false,extraConstraints=[],mealCount=5}){
  const usedWeekIds=new Set();
  const sequence=Rules.dayTypeSequence({carbCycling,days,sequence:requestedSequence});
  const cq=await pool.query('SELECT kind,constraint_key,value,severity,source FROM client_constraint WHERE client_id=$1 ORDER BY id',[clientId]);
  const constraintState=Constraints.splitConstraints([...cq.rows,...(extraConstraints||[])]);
  const week=[];
  for(let i=0;i<sequence.length;i++){
    const day=await generateDay({targets,clientId,dayType:sequence[i],usedWeekIds,pool,allowWarnings,constraintState,mealCount});
    week.push({day_index:i,day_name:`Day ${i+1}`,...day,totals:planTotals(day.items)});
  }
  const metrics={days:week.length,totals:week.reduce((a,d)=>{for(const k of Object.keys(a))a[k]+=Number(d.totals[k]||0);return a;},{kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0})};
  metrics.averagePerDay=Object.fromEntries(Object.entries(metrics.totals).map(([k,v])=>[k,week.length?v/week.length:0]));
  const quality=Rules.qualityReport({days:week,targets});
  return {days:week,metrics,quality,dayTypeSequence:sequence,qualityLane:allowWarnings?'AUTO_WITH_WARNING_ALLOWED':'AUTO_ELIGIBLE_ONLY'};
}

function generateWeekFromCandidates({targets, candidatePool, carbCycling=false}){
  const sequence=Rules.dayTypeSequence({carbCycling,days:7});
  const usedWeekIds=new Set();
  const days=sequence.map((dayType,i)=>({day_index:i,...generateDayFromCandidates({targets,dayType,candidatePool,usedWeekIds}),day_name:`Day ${i+1}`}));
  return {days,quality:Rules.qualityReport({days,targets}),dayTypeSequence:sequence};
}
module.exports={
  WEIGHTS, generateWeek, generateDay,
  scoreCandidate, scorePlan, planTotals, improvePlan, duplicateIds, weekMetrics,
  __test_pickBest:testPickBest, __test_queryCandidates:queryCandidates, __test_scoreCandidate:scoreCandidate, __test_scorePlan:scorePlan,
  __test_planTotals:planTotals, __test_weekMetrics:weekMetrics, __test_duplicateIds:duplicateIds,
  __test_improvePlan:(slotCandidates,plan,targetTotal,usedWeek)=>improvePlan(slotCandidates,plan,targetTotal,usedWeek).plan, __test_querySql:()=>queryCandidates.toString(),
  __test_dayTypeSequence:Rules.dayTypeSequence, __test_adjustTargets:Rules.adjustTargets, __test_qualityReport:Rules.qualityReport
};
