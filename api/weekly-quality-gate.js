'use strict';

function finite(v){ return Number.isFinite(Number(v)); }
function pctDistance(actual,target){
  if(target==null || Number(target)===0 || actual==null || !finite(actual)) return 0;
  return Math.abs(Number(actual)-Number(target))/Math.max(Math.abs(Number(target)),1);
}

function summarizeDays(days=[]){
  const requiredSlots = ['فطار','سناك ١','غداء','سناك ٢','عشاء'];
  const blockers=[]; const warnings=[]; const daySummaries=[];
  for(const d of days){
    const items = d.items || {};
    const missingSlots = requiredSlots.filter(s=>!items[s]);
    const unresolved=[];
    const missingCore=[];
    for(const [slot,item] of Object.entries(items)){
      if(!item) continue;
      if(item.status && item.status !== 'COMPUTABLE' && item.status !== 'CUSTOM') unresolved.push({slot,status:item.status});
      if(item.evidence_tier && !['high','verified','calculated'].includes(String(item.evidence_tier).toLowerCase())) unresolved.push({slot,evidence_tier:item.evidence_tier});
      for(const field of ['kcal','protein_g','carb_g','fat_g']){
        if(item[field] == null || !finite(item[field])) missingCore.push({slot,field});
      }
    }
    if(missingSlots.length) blockers.push({day_index:d.day_index,code:'missing_slots',slots:missingSlots});
    if(unresolved.length) blockers.push({day_index:d.day_index,code:'unresolved_items',items:unresolved});
    if(missingCore.length) blockers.push({day_index:d.day_index,code:'missing_core_macros',items:missingCore});
    const totals=d.totals || {};
    daySummaries.push({day_index:d.day_index, day_type:d.day_type||'medium', totals, missingSlots, unresolved, missingCore});
  }
  return {daySummaries,blockers,warnings};
}

function evaluate({days=[],targets={},policy={},baseQuality=null}={}){
  const summary=summarizeDays(days);
  const daysN=Math.max(days.length,1);
  const avg={kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0};
  for(const d of days){ for(const k of Object.keys(avg)) avg[k]+=Number((d.totals||{})[k]||0); }
  for(const k of Object.keys(avg)) avg[k]/=daysN;

  const bounds=policy.target_overrides || {};
  const boundChecks=[];
  const map=[
    ['kcal','min_kcal','max_kcal'],['protein_g','min_protein_g','max_protein_g'],
    ['carb_g','min_carb_g','max_carb_g'],['fat_g','min_fat_g','max_fat_g'],['fiber_g','min_fiber_g','max_fiber_g']
  ];
  for(const [field,minK,maxK] of map){
    const value=Number(avg[field]||0); const min=bounds[minK], max=bounds[maxK];
    if(min!=null && value < Number(min)) boundChecks.push({field,type:'below_min',value,bound:Number(min)});
    if(max!=null && value > Number(max)) boundChecks.push({field,type:'above_max',value,bound:Number(max)});
  }

  const targetChecks=[];
  const tmap=[['kcal','kcal'],['protein_g','protein'],['carb_g','carb'],['fat_g','fat'],['fiber_g','fiber']];
  for(const [actualKey,targetKey] of tmap){
    const target=Number(targets[targetKey]||0); const actual=Number(avg[actualKey]||0);
    if(target>0) targetChecks.push({field:actualKey,target,actual,relativeError:pctDistance(actual,target)});
  }

  const repeatMap=new Map();
  for(const d of days){ for(const item of Object.values(d.items||{}).filter(Boolean)){ const id=item.canonical_id; if(id) repeatMap.set(id,(repeatMap.get(id)||0)+1); }}
  const repeats=[...repeatMap.entries()].filter(([,n])=>n>2).map(([canonical_id,count])=>({canonical_id,count}));
  if(repeats.length) summary.warnings.push({code:'excessive_weekly_reuse',items:repeats});

  for(const b of boundChecks) summary.blockers.push({code:'policy_bound_violation',...b});
  if(summary.blockers.length===0 && repeats.length) summary.warnings.push({code:'review_weekly_variety',count:repeats.length});

  const maxError = targetChecks.reduce((m,x)=>Math.max(m,x.relativeError),0);
  const scoreBase = Number(baseQuality?.score ?? 100);
  const score = Math.max(0, Math.min(100, Math.round((scoreBase - maxError*20 - summary.blockers.length*12 - summary.warnings.length*2)*10)/10));
  return {
    ok:summary.blockers.length===0,
    status:summary.blockers.length ? 'BLOCKED' : (summary.warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS'),
    score,
    blockers:summary.blockers,
    warnings:summary.warnings,
    average:avg,
    targetChecks,
    boundChecks,
    repeatedItems:repeats,
    daySummaries:summary.daySummaries,
    rules_version:'v5.0-weekly-quality-gate-1'
  };
}

module.exports={evaluate,summarizeDays};
