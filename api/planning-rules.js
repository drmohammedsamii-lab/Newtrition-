'use strict';

const DAY_TYPES = Object.freeze({
  low:    Object.freeze({ carbFactor: 0.80, fatFactor: 1.10 }),
  medium: Object.freeze({ carbFactor: 1.00, fatFactor: 1.00 }),
  high:   Object.freeze({ carbFactor: 1.20, fatFactor: 0.90 }),
});

const PORTION_BANDS = Object.freeze({
  'فطار': { min: 50, max: 600 },
  'سناك ١': { min: 20, max: 350 },
  'سناك ٢': { min: 20, max: 350 },
  'غداء': { min: 80, max: 750 },
  'عشاء': { min: 70, max: 700 },
});

function finite(v){ return Number.isFinite(Number(v)); }
function clamp(v,min,max){ return Math.min(max,Math.max(min,v)); }

function dayTypeSequence({carbCycling=false, days=7, sequence}={}){
  if (Array.isArray(sequence) && sequence.length) return sequence.slice(0, Math.min(7, Math.max(1, Number(days)||7)));
  const n = Math.min(7, Math.max(1, Number(days)||7));
  if (!carbCycling) return Array.from({length:n},()=> 'medium');
  const pattern = ['medium','high','medium','low','medium','high','low'];
  return pattern.slice(0,n);
}

function adjustTargets(base, type){
  const profile = DAY_TYPES[type] || DAY_TYPES.medium;
  const kcal = Number(base.kcal||0);
  const protein = Number(base.protein||0);
  const baseCarb = Number(base.carb||0);
  const baseFat = Number(base.fat||0);
  const carb = Math.max(0, Math.round(baseCarb * profile.carbFactor));
  // Keep calories roughly stable by moving the difference into fat.
  const carbDeltaKcal = (carb - baseCarb) * 4;
  let fat = Math.max(0, Math.round((kcal - protein*4 - carb*4) / 9));
  if (!finite(fat) || fat === 0 && baseFat > 0) fat = Math.max(0, Math.round(baseFat - carbDeltaKcal/9));
  const fiber = Math.round(Number(base.fiber||0) * (0.95 + (type==='high'?0.05:0)));
  return { ...base, carb, fat, fiber, day_type:type };
}

function portionPenalty(slot, grams){
  if (!finite(grams) || Number(grams)<=0) return 0.35; // unknown serving = uncertainty, not automatic rejection
  const band = PORTION_BANDS[slot];
  if (!band) return 0.10;
  const g = Number(grams);
  if (g < band.min) return Math.min(1.5, (band.min-g)/band.min);
  if (g > band.max) return Math.min(1.5, (g-band.max)/band.max);
  // small preference for the middle of the serving band
  const mid=(band.min+band.max)/2;
  return Math.min(0.12, Math.abs(g-mid)/mid*0.12);
}

function qualityReport({days=[], targets={}}={}){
  const totals={kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0};
  const ids=[]; const unresolved=[]; const missing=[]; const dayReports=[];
  for(const d of days){
    const dt={kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0};
    for(const i of Object.values(d.items||{}).filter(Boolean)){
      ids.push(i.canonical_id || `custom:${i.name_ar||i.custom_name||'x'}`);
      for(const [k,src] of [['kcal','kcal'],['protein_g','protein_g'],['carb_g','carb_g'],['fat_g','fat_g'],['fiber_g','fiber_g']]){
        const v=i[src];
        if(v==null || !finite(v)) missing.push({day:d.day_index,slot:i.slot,field:k});
        else { dt[k]+=Number(v); totals[k]+=Number(v); }
      }
      if(i.status && i.status!=='COMPUTABLE') unresolved.push({day:d.day_index,slot:i.slot,status:i.status,canonical_id:i.canonical_id});
      if(i.evidence_tier && !['high','verified','calculated'].includes(i.evidence_tier)) unresolved.push({day:d.day_index,slot:i.slot,evidence_tier:i.evidence_tier,canonical_id:i.canonical_id});
    }
    dayReports.push({day_index:d.day_index,day_type:d.day_type||'medium',totals:dt});
  }
  const daysN=Math.max(days.length,1);
  const averages=Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v/daysN]));
  const repeatMap=new Map(); ids.forEach(id=>repeatMap.set(id,(repeatMap.get(id)||0)+1));
  const repeatCount=[...repeatMap.values()].reduce((a,n)=>a+(n>1?n-1:0),0);
  const deviation={};
  for(const [field,targetKey] of [['kcal','kcal'],['protein_g','protein'],['carb_g','carb'],['fat_g','fat'],['fiber_g','fiber']]){
    const target=Number(targets[targetKey]||0)*daysN;
    deviation[field]=target>0?Math.abs(totals[field]-target)/target:0;
  }
  const missingHard=missing.filter(x=>x.field==='kcal'||x.field==='protein_g'||x.field==='carb_g'||x.field==='fat_g');
  const missingSoft=missing.filter(x=>x.field==='fiber_g');
  const blockers=[];
  if(unresolved.length) blockers.push('unresolved_data');
  if(missingHard.length) blockers.push('missing_core_macros');
  const warnings=[];
  if(missingSoft.length) warnings.push('missing_fiber_data');
  if(repeatCount>3) warnings.push('too_many_repeats');
  const score = 100 - clamp(
    deviation.kcal*30 + deviation.protein_g*35 + deviation.carb_g*15 + deviation.fat_g*10 + deviation.fiber_g*5 + repeatCount*1.5 + missingHard.length*3 + missingSoft.length*0.5 + unresolved.length*10,
    0,100
  );
  return {score:Math.round(score*10)/10, totals, averages, deviation, uniqueItems:new Set(ids).size, itemCount:ids.length, repeatCount, missing, missingHard, missingSoft, unresolved, blockers, warnings, readyForClinicalReview:blockers.length===0, dayReports};
}

module.exports={DAY_TYPES,PORTION_BANDS,dayTypeSequence,adjustTargets,portionPenalty,qualityReport};
