'use strict';
const { slotBudget } = require('./nutrition-engine');
const Rules = require('./planning-rules');
const Weights = Object.freeze({ kcal:34, protein:34, carb:12, fat:10, fiber:4, repeatDay:14, repeatWeek:24, lowProtein:20, portion:6, evidence:8 });
function num(v){ return v==null?null:Number(v); }
function pct(actual,target){ if(actual==null||target==null||Number(target)===0) return null; return Math.abs(Number(actual)-Number(target))/Math.max(Math.abs(Number(target)),1)*100; }
function evidencePenalty(tier){ return ({high:0,verified:0.05,calculated:0.12,estimated:0.60,unknown:1})[String(tier||'unknown').toLowerCase()] ?? 1; }
function explainCandidate(candidate,target,usedDay=new Set(),usedWeek=new Set()){
  const c=candidate||{}; const t=target||{};
  const details=[]; let score=0;
  const add=(name,weight,raw,reason)=>{ const contribution=weight*raw; score+=contribution; details.push({factor:name,weight,raw:Math.round(raw*1000)/1000,contribution:Math.round(contribution*1000)/1000,reason}); };
  const kd=pct(num(c.kcal),num(t.kcal)); if(kd!=null) add('calorie_fit',Weights.kcal,kd/100,`Calories ${num(c.kcal)} vs slot target ${num(t.kcal)} kcal.`);
  const pd=pct(num(c.protein_g),num(t.protein)); if(pd!=null) add('protein_fit',Weights.protein,pd/100,`Protein ${num(c.protein_g)}g vs slot target ${num(t.protein)}g.`);
  const cd=pct(num(c.carb_g),num(t.carb)); if(cd!=null) add('carb_fit',Weights.carb,cd/100,`Carbs ${num(c.carb_g)}g vs slot target ${num(t.carb)}g.`);
  const fd=pct(num(c.fat_g),num(t.fat)); if(fd!=null) add('fat_fit',Weights.fat,fd/100,`Fat ${num(c.fat_g)}g vs slot target ${num(t.fat)}g.`);
  const fibd=pct(num(c.fiber_g),num(t.fiber)); if(fibd!=null) add('fiber_fit',Weights.fiber,fibd/100,`Fiber ${num(c.fiber_g)}g vs slot target ${num(t.fiber)}g.`);
  if(t.protein>0 && num(c.protein_g)!=null && num(c.protein_g)<t.protein*0.5){ add('low_protein_penalty',Weights.lowProtein,1,'Protein is below 50% of the slot target.'); }
  if(usedDay.has(c.canonical_id)) add('same_day_repeat',Weights.repeatDay,1,'The item is already used in this day.');
  if(usedWeek.has(c.canonical_id)) add('week_repeat',Weights.repeatWeek,1,'The item was already used earlier in the week.');
  if(Array.isArray(t.allowedCategories) && !t.allowedCategories.includes(c.category)) add('category_mismatch',40,1,`Category ${c.category} is outside the slot categories.`);
  const portionPenalty=Rules.portionPenalty(t.slot,c.portion_grams); if(portionPenalty) add('portion_fit',Weights.portion,portionPenalty, c.portion_grams?`Portion ${c.portion_grams}g is compared with the ${t.slot} portion band.`:'Serving size is unknown, so uncertainty is penalized.');
  if(c.constraint_penalty) add('constraint_penalty',1,Number(c.constraint_penalty),'A soft client preference penalty was applied.');
  if(c.portion_score!=null) add('portion_score',2,1-Number(c.portion_score),'Portion engine score contribution.');
  const ep=evidencePenalty(c.evidence_tier); if(ep) add('evidence',Weights.evidence,ep,`Evidence tier: ${c.evidence_tier||'unknown'}.`);
  details.sort((a,b)=>b.contribution-a.contribution);
  return {canonical_id:c.canonical_id||null,name_ar:c.name_ar||c.custom_name||null,slot:t.slot||null,score:Math.round(score*100)/100,primary_reasons:details.slice(0,4).map(x=>x.reason),factors:details};
}
function explainWeek(days,targets={}){
  const out=[]; const usedWeek=new Set();
  for(const d of days||[]){
    const dayTargets=Rules.adjustTargets(targets,d.day_type||'medium');
    const specs=slotBudget(dayTargets); const usedDay=new Set(); const items=[];
    for(const spec of specs){
      const item=(d.items||{})[spec.key];
      if(!item) continue;
      const target={...spec,slot:spec.key};
      const explanation=explainCandidate(item,target,usedDay,usedWeek);
      items.push(explanation); if(item.canonical_id){ usedDay.add(item.canonical_id); usedWeek.add(item.canonical_id); }
    }
    out.push({day_index:d.day_index,day_type:d.day_type||'medium',items});
  }
  return {version:'v5.2-explainability-1',days:out};
}
module.exports={explainCandidate,explainWeek};
