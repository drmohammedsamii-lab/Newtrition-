'use strict';

const ALIASES = Object.freeze({
  'لبن':'milk','حليب':'milk','dairy':'milk','milk':'milk','جبنة':'milk','cheese':'milk',
  'جمبري':'shellfish','shrimp':'shellfish','shellfish':'shellfish',
  'فول سوداني':'peanut','peanut':'peanut',
  'مكسرات':'tree_nut','tree nuts':'tree_nut','tree_nut':'tree_nut',
  'بيض':'egg','egg':'egg',
  'قمح':'wheat','wheat':'wheat','gluten':'gluten',
  'سمك':'fish','fish':'fish',
  'صويا':'soy','soy':'soy',
  'سمسم':'sesame','sesame':'sesame'
});

function norm(v){ return String(v ?? '').trim().toLowerCase(); }
function normalizeKey(v){ return ALIASES[norm(v)] || norm(v); }

function normalizeConstraint(x={}){
  const kind=norm(x.kind || 'preference');
  const severity=String(x.severity || 'HARD').toUpperCase();
  const key=normalizeKey(x.constraint_key || '');
  const value=normalizeKey(x.value || '');
  return { kind, severity, constraint_key:key, value, source:x.source || null };
}

function splitConstraints(rows=[]){
  const hard=[]; const soft=[]; const info=[];
  for(const row of rows){
    const c=normalizeConstraint(row);
    if(!c.constraint_key || !c.value) continue;
    if(c.severity==='INFO') info.push(c);
    else if(c.severity==='SOFT') soft.push(c);
    else hard.push(c);
  }
  return {hard,soft,info};
}

function getHardAllergens(constraints){
  return new Set((constraints.hard||[])
    .filter(c=>c.kind==='allergen' || c.constraint_key==='allergen')
    .map(c=>normalizeKey(c.value)));
}

function getHardDiets(constraints){
  return new Set((constraints.hard||[])
    .filter(c=>c.kind==='diet' || c.constraint_key==='diet')
    .map(c=>normalizeKey(c.value)));
}

function containsToken(list, wanted){
  const w=normalizeKey(wanted);
  return (list||[]).some(v=>normalizeKey(v)===w || normalizeKey(v).includes(w) || w.includes(normalizeKey(v)));
}

function evaluateCandidate(candidate, constraints){
  const allergens=(candidate.allergens||[]).map(normalizeKey);
  const ingredients=(candidate.ingredients||[]).map(norm);
  const hardAllergens=getHardAllergens(constraints);
  const profileStatus = candidate.allergen_profile_status || 'UNKNOWN';

  // Rule 1 — a positive tag ALWAYS blocks, regardless of verification.
  // Inference only ever adds exclusions, so acting on an unverified
  // positive tag immediately cannot make anything less safe than before
  // the tag existed.
  for(const a of hardAllergens){
    if(containsToken(allergens,a) || ingredients.some(i=>i.includes(a) && ['milk','cheese','cream','shrimp','prawn','peanut','nut','egg','wheat','fish','soy','sesame'].includes(a))){
      return {eligible:false, reason:`allergen:${a}`};
    }
  }

  // Rule 2 — an ABSENCE of a tag is only trustworthy once a clinician has
  // confirmed the food's allergen profile is complete (VERIFIED). Zero
  // tags and "inferred but not yet reviewed" are treated the same way
  // here on purpose: a partially-tagged item (say, only gluten was
  // caught) is more dangerous than an untagged one if its non-empty
  // allergens array were allowed to imply "everything else is absent" —
  // it would silently pass a check for an allergen nobody has looked for
  // yet. Only VERIFIED profiles are allowed to assert an allergen is
  // genuinely absent.
  if(hardAllergens.size && profileStatus !== 'VERIFIED'){
    return {eligible:false, reason:`allergen:unverified_profile:${profileStatus.toLowerCase()}`};
  }

  const hardDiets=getHardDiets(constraints);
  for(const d of hardDiets){
    const tags=(candidate.diet_tags||[]).map(normalizeKey);
    if(!containsToken(tags,d)) return {eligible:false, reason:`diet:${d}`};
  }

  for(const c of constraints.hard||[]){
    if(c.kind==='meal' && c.value==='avoid' && c.constraint_key && String(candidate.category||'').toLowerCase()===c.constraint_key){
      return {eligible:false,reason:`meal:avoid:${c.constraint_key}`};
    }
    if(c.kind==='preference' && c.value==='avoid'){
      const hay=[candidate.name_ar,candidate.name_en,candidate.brand,candidate.category].filter(Boolean).map(norm).join(' | ');
      if(hay.includes(c.constraint_key)) return {eligible:false,reason:`preference:avoid:${c.constraint_key}`};
    }
  }

  let softPenalty=0;
  for(const c of constraints.soft||[]){
    if(c.kind==='preference'){
      const hay=[candidate.name_ar,candidate.name_en,candidate.brand,candidate.category].filter(Boolean).map(norm).join(' | ');
      if(!hay.includes(c.constraint_key)) softPenalty += 4;
    }
  }
  return {eligible:true,softPenalty};
}

module.exports={normalizeKey,normalizeConstraint,splitConstraints,getHardAllergens,getHardDiets,evaluateCandidate};
