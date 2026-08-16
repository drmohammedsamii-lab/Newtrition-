'use strict';

const SUPPORTED_MACRO_KEYS = new Set([
  'min_kcal','max_kcal','min_protein_g','max_protein_g','min_carb_g','max_carb_g',
  'min_fat_g','max_fat_g','min_fiber_g','max_fiber_g','meal_count'
]);

function norm(v){ return String(v ?? '').trim().toLowerCase(); }
function num(v){ return v == null || v === '' ? null : Number(v); }
function finite(v){ return Number.isFinite(Number(v)); }

function readExplicitMacroConstraints(rows=[]){
  const out = {};
  const warnings = [];
  for(const r of rows){
    if(norm(r.kind) !== 'macro') continue;
    const key = norm(r.constraint_key);
    const value = num(r.value);
    if(!SUPPORTED_MACRO_KEYS.has(key)){
      warnings.push({type:'unsupported_macro_rule', key, value:r.value, severity:r.severity||'HARD'});
      continue;
    }
    if(!finite(value) || value < 0){
      warnings.push({type:'invalid_macro_rule', key, value:r.value});
      continue;
    }
    out[key] = value;
  }
  if(out.min_kcal != null && out.max_kcal != null && out.min_kcal > out.max_kcal)
    warnings.push({type:'inverted_range', fields:['min_kcal','max_kcal']});
  if(out.min_protein_g != null && out.max_protein_g != null && out.min_protein_g > out.max_protein_g)
    warnings.push({type:'inverted_range', fields:['min_protein_g','max_protein_g']});
  if(out.min_carb_g != null && out.max_carb_g != null && out.min_carb_g > out.max_carb_g)
    warnings.push({type:'inverted_range', fields:['min_carb_g','max_carb_g']});
  if(out.min_fat_g != null && out.max_fat_g != null && out.min_fat_g > out.max_fat_g)
    warnings.push({type:'inverted_range', fields:['min_fat_g','max_fat_g']});
  if(out.min_fiber_g != null && out.max_fiber_g != null && out.min_fiber_g > out.max_fiber_g)
    warnings.push({type:'inverted_range', fields:['min_fiber_g','max_fiber_g']});
  return {out,warnings};
}

function buildPolicy({client, constraints=[]}={}){
  const rows = constraints.map(x => ({...x, severity:String(x.severity||'HARD').toUpperCase()}));
  const macro = readExplicitMacroConstraints(rows);
  const hard = rows.filter(x=>x.severity==='HARD');
  const soft = rows.filter(x=>x.severity==='SOFT');
  const info = rows.filter(x=>x.severity==='INFO');
  const warnings = [...macro.warnings];

  // Medical/clinical text is never interpreted as a rule by itself.
  const unsupportedMedical = hard.filter(x => norm(x.kind)==='medical');
  if(unsupportedMedical.length){
    warnings.push({
      type:'medical_rule_requires_explicit_mapping',
      count:unsupportedMedical.length,
      keys:unsupportedMedical.map(x=>String(x.constraint_key||''))
    });
  }

  const policy = {
    version:'v4.2-clinical-policy-1',
    client_id: client?.id ?? null,
    hard_constraints: hard,
    soft_constraints: soft,
    info_constraints: info,
    macro_constraints: macro.out,
    unsupported_medical_rules: unsupportedMedical,
    warnings,
    target_overrides: {
      min_kcal: macro.out.min_kcal ?? null,
      max_kcal: macro.out.max_kcal ?? null,
      min_protein_g: macro.out.min_protein_g ?? null,
      max_protein_g: macro.out.max_protein_g ?? null,
      min_carb_g: macro.out.min_carb_g ?? null,
      max_carb_g: macro.out.max_carb_g ?? null,
      min_fat_g: macro.out.min_fat_g ?? null,
      max_fat_g: macro.out.max_fat_g ?? null,
      min_fiber_g: macro.out.min_fiber_g ?? null,
      max_fiber_g: macro.out.max_fiber_g ?? null,
      meal_count: macro.out.meal_count ?? null
    }
  };
  return policy;
}

function applyTargetBounds(targets={}, policy={}){
  const t={...targets};
  const m=policy.target_overrides||{};
  const warnings=[];
  const bounds=[
    ['kcal','min_kcal','max_kcal'],
    ['protein','min_protein_g','max_protein_g'],
    ['carb','min_carb_g','max_carb_g'],
    ['fat','min_fat_g','max_fat_g'],
    ['fiber','min_fiber_g','max_fiber_g']
  ];
  for(const [field,minK,maxK] of bounds){
    const min=m[minK], max=m[maxK];
    if(min!=null && t[field] < min){ warnings.push({type:'target_raised_to_min',field,from:t[field],to:min}); t[field]=min; }
    if(max!=null && t[field] > max){ warnings.push({type:'target_lowered_to_max',field,from:t[field],to:max}); t[field]=max; }
  }
  return {targets:t,warnings};
}

function evaluatePlanBounds(totals={}, policy={}){
  const m=policy.target_overrides||{};
  const failures=[];
  const checks=[
    ['kcal','min_kcal','max_kcal'],['protein_g','min_protein_g','max_protein_g'],
    ['carb_g','min_carb_g','max_carb_g'],['fat_g','min_fat_g','max_fat_g'],['fiber_g','min_fiber_g','max_fiber_g']
  ];
  for(const [field,minK,maxK] of checks){
    const v=Number(totals[field]||0);
    if(m[minK]!=null && v<m[minK]) failures.push({field,type:'below_min',value:v,bound:m[minK]});
    if(m[maxK]!=null && v>m[maxK]) failures.push({field,type:'above_max',value:v,bound:m[maxK]});
  }
  return {ok:failures.length===0,failures};
}

module.exports={SUPPORTED_MACRO_KEYS,readExplicitMacroConstraints,buildPolicy,applyTargetBounds,evaluatePlanBounds};
