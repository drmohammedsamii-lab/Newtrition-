'use strict';

const SCHEMA_VERSION = 'v6.6-ai-planning-copilot-1';
const SUPPORTED_MEALS = new Set([3,4,5]);

const ALLERGEN_ALIASES = [
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:لبن|حليب|dairy|milk)/i,'milk'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:جبنة|جبن|cheese)/i,'milk'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:جمبري|shrimp|shellfish)/i,'shellfish'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:بيض|egg|eggs)/i,'egg'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:قمح|wheat|gluten)/i,'gluten'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:فول سوداني|peanut)/i,'peanut'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:مكسرات|nuts|tree nuts)/i,'tree_nut'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:سمك|fish)/i,'fish'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:صويا|soy)/i,'soy'],
  [/(?:بدون|من غير|لا يوجد|no|without)\s+(?:سمسم|sesame)/i,'sesame']
];

const DIET_PATTERNS = [
  [/(?:vegetarian|نباتي|نباتية)/i,'vegetarian'],
  [/(?:vegan|نباتي صرف|نباتية صرف)/i,'vegan'],
  [/(?:keto|كيتو)/i,'keto'],
  [/(?:low\s*carb|قليل\s*كارب|قليل الكربوهيدرات)/i,'low_carb'],
  [/(?:mediterranean|متوسطي|متوسطية)/i,'mediterranean']
];

const KEYWORDS = Object.freeze({
  egyptian: /(?:مصري|مصرية|egyptian)/i,
  carb_cycling: /(?:carb\s*cycling|carb cycle|كارب\s*سايكل|تدوير الكارب)/i,
  high_protein: /(?:high\s*protein|عالي البروتين|بروتين عالي)/i,
  allow_warnings: /(?:allow\s*warnings|مع التحذيرات|اسمح بالتحذيرات)/i
});

function num(v){ if(v===null || v===undefined || v==='') return null; const n=Number(String(v).replace(/,/g,'')); return Number.isFinite(n)?n:null; }
function clean(v,max=160){ const s=String(v??'').trim(); return s?s.slice(0,max):null; }
function unique(xs){ return [...new Set((xs||[]).filter(Boolean).map(String))].slice(0,20); }

function findNumberAround(text, regexes){
  for(const re of regexes){ const m=text.match(re); if(m) return num(m[1]); }
  return null;
}

function parseArabicDuration(text){
  const t=String(text||'');
  if(/(?:يومين|يومان)/.test(t)) return 2;
  if(/ثلاث(?:ة)?\s*أيام/.test(t)) return 3;
  if(/أربع(?:ة)?\s*أيام/.test(t)) return 4;
  if(/خمس(?:ة)?\s*أيام/.test(t)) return 5;
  if(/ست(?:ة)?\s*أيام/.test(t)) return 6;
  if(/سبع(?:ة)?\s*أيام/.test(t)) return 7;
  if(/(?:يوم واحد|يوم)/.test(t)) return 1;
  if(/أسبوعين/.test(t)) return 14;
  if(/أسبوع/.test(t)) return 7;
  return null;
}

function parseDeterministic(task){
  const text=String(task||'').trim();
  const kcal=findNumberAround(text,[
    /(?:لـ|لهدف|هدف|target)?\s*(\d{3,4})\s*(?:kcal|كالوري|سعرة|سعر|calories?)/i,
    /(?:kcal|calories?|كالوري|سعرة|سعر)\s*[:=]?\s*(\d{3,4})/i
  ]);
  const protein=findNumberAround(text,[
    /(?:protein|بروتين)\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)\s*(?:g|جم|جرام)?/i,
    /(\d{2,3}(?:\.\d+)?)\s*(?:g|جم|جرام)\s*(?:protein|بروتين)/i,
    /(\d{2,3}(?:\.\d+)?)\s*(?:protein|بروتين)/i
  ]);
  const carb=findNumberAround(text,[
    /(?:carb|carbs|كارب|كربوهيدرات)\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)\s*(?:g|جم|جرام)?/i
  ]);
  const fat=findNumberAround(text,[
    /(?:fat|دهون)\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)\s*(?:g|جم|جرام)?/i
  ]);
  const fiber=findNumberAround(text,[
    /(?:fiber|ألياف)\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*(?:g|جم|جرام)?/i
  ]);
  const mealsRaw=findNumberAround(text,[
    /(?:([3-5]))\s*(?:meals?|وجبات)/i,
    /(?:meals?|وجبات)\s*[:=]?\s*([3-5])/i
  ]);
  const daysRaw=findNumberAround(text,[/(?:([1-7]))\s*(?:days?|أيام)/i,/(?:days?|أيام)\s*[:=]?\s*([1-7])/i]) || parseArabicDuration(text);

  const excluded=[];
  for(const [re,a] of ALLERGEN_ALIASES) if(re.test(text)) excluded.push(a);
  const diet_tags=[];
  for(const [re,d] of DIET_PATTERNS) if(re.test(text)) diet_tags.push(d);

  const constraints=[];
  for(const a of unique(excluded)) constraints.push({kind:'allergen',constraint_key:'allergen',value:a,severity:'HARD',source:'ai_copilot_user_request'});
  for(const d of unique(diet_tags)) constraints.push({kind:'diet',constraint_key:'diet',value:d,severity:'HARD',source:'ai_copilot_user_request'});

  return normalizeIntent({
    target_kcal:kcal,
    target_protein_g:protein,
    target_carb_g:carb,
    target_fat_g:fat,
    target_fiber_g:fiber,
    meals_per_day:mealsRaw,
    days:daysRaw||7,
    excluded_allergens:unique(excluded),
    diet_tags:unique(diet_tags),
    cuisine:KEYWORDS.egyptian.test(text)?'egyptian':null,
    carb_cycling:KEYWORDS.carb_cycling.test(text),
    high_protein:KEYWORDS.high_protein.test(text),
    allow_warnings:KEYWORDS.allow_warnings.test(text),
    constraints,
    notes:text
  });
}

function normalizeIntent(x={}){
  const intent={
    schema_version:SCHEMA_VERSION,
    target_kcal:num(x.target_kcal),
    target_protein_g:num(x.target_protein_g),
    target_carb_g:num(x.target_carb_g),
    target_fat_g:num(x.target_fat_g),
    target_fiber_g:num(x.target_fiber_g),
    meals_per_day:x.meals_per_day==null?5:Number(x.meals_per_day),
    days:x.days==null?7:Number(x.days),
    excluded_allergens:unique(x.excluded_allergens),
    diet_tags:unique(x.diet_tags),
    cuisine:clean(x.cuisine,60),
    carb_cycling:Boolean(x.carb_cycling),
    high_protein:Boolean(x.high_protein),
    allow_warnings:Boolean(x.allow_warnings),
    constraints:Array.isArray(x.constraints)?x.constraints.slice(0,50):[],
    notes:clean(x.notes,1200)
  };
  const errors=[];
  if(intent.target_kcal!=null && intent.target_kcal<=0) errors.push('target_kcal_invalid');
  if(intent.target_protein_g!=null && intent.target_protein_g<0) errors.push('target_protein_invalid');
  if(!SUPPORTED_MEALS.has(intent.meals_per_day)) errors.push('unsupported_meals_per_day');
  if(!Number.isInteger(intent.days) || intent.days<1 || intent.days>7) errors.push('days_invalid');
  if(!intent.target_kcal || !intent.target_protein_g) errors.push('missing_required_targets');
  return {intent,errors,ready:errors.length===0};
}

const OUTPUT_SCHEMA={
  type:'object',additionalProperties:false,
  properties:{
    target_kcal:{anyOf:[{type:'number'},{type:'null'}]},
    target_protein_g:{anyOf:[{type:'number'},{type:'null'}]},
    target_carb_g:{anyOf:[{type:'number'},{type:'null'}]},
    target_fat_g:{anyOf:[{type:'number'},{type:'null'}]},
    target_fiber_g:{anyOf:[{type:'number'},{type:'null'}]},
    meals_per_day:{type:'integer'},
    days:{type:'integer'},
    excluded_allergens:{type:'array',items:{type:'string'}},
    diet_tags:{type:'array',items:{type:'string'}},
    cuisine:{anyOf:[{type:'string'},{type:'null'}]},
    carb_cycling:{type:'boolean'},
    high_protein:{type:'boolean'},
    allow_warnings:{type:'boolean'},
    notes:{anyOf:[{type:'string'},{type:'null'}]}
  },
  required:['target_kcal','target_protein_g','target_carb_g','target_fat_g','target_fiber_g','meals_per_day','days','excluded_allergens','diet_tags','cuisine','carb_cycling','high_protein','allow_warnings','notes']
};

function buildOpenAIRequest({task,model='gpt-5.6'}){
  const system='You are a nutrition planning request parser for Newtrition. Convert only explicit user requirements into structured constraints. Do not invent targets. Do not diagnose. Do not create a diet plan. Keep unsupported clinical claims out. If a value is absent, return null.';
  return {
    model,store:false,
    input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:String(task||'') }]}],
    text:{format:{type:'json_schema',name:'newtrition_ai_plan_intent',strict:true,schema:OUTPUT_SCHEMA}}
  };
}

async function parseWithOpenAI({task}){
  const key=process.env.OPENAI_API_KEY;
  if(!key) throw Object.assign(new Error('ai_provider_not_configured'),{status:503});
  const model=process.env.OPENAI_MODEL||'gpt-5.6';
  const request=buildOpenAIRequest({task,model});
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(request)});
  const raw=await r.text();
  if(!r.ok) throw Object.assign(new Error('ai_provider_error'),{status:502});
  let data; try{data=JSON.parse(raw);}catch{throw Object.assign(new Error('ai_invalid_response'),{status:502});}
  let text=String(data.output_text||'').trim();
  if(!text){ for(const item of (data.output||[])){ for(const part of (item.content||[])){ if(part.type==='output_text'&&part.text){text=part.text;break;} } if(text)break; } }
  if(!text) throw Object.assign(new Error('ai_unstructured_response'),{status:502});
  let parsed; try{parsed=JSON.parse(text);}catch{throw Object.assign(new Error('ai_invalid_json'),{status:502});}
  const normalized=normalizeIntent({...parsed,constraints:[]});
  if(normalized.errors.length) throw Object.assign(new Error('ai_intent_invalid'),{status:502});
  return {intent:normalized.intent,provider:'openai',model};
}

async function parse({task}){
  const t=clean(task,1200);
  if(!t) throw Object.assign(new Error('task_required'),{status:400});
  const provider=(process.env.NEWTRITION_AI_PROVIDER||'mock').toLowerCase();
  if(provider==='openai') return {task:t,...await parseWithOpenAI({task:t})};
  if(provider!=='mock') throw Object.assign(new Error('unsupported_ai_provider'),{status:500});
  const p=parseDeterministic(t);
  return {task:t,provider:'mock',model:null,...p};
}

function mergeConstraints(existing=[],intent={}){
  const extras=[...(existing||[])];
  for(const c of intent.constraints||[]) extras.push(c);
  return extras;
}

module.exports={SCHEMA_VERSION,OUTPUT_SCHEMA,parse,parseDeterministic,normalizeIntent,mergeConstraints,buildOpenAIRequest};
