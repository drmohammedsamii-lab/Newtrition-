/**
 * Newtrition V6.5 — AI Assistant Layer.
 *
 * Safe boundary around an optional external model.
 * - Default provider is MOCK so the app never calls an external AI service by accident.
 * - OpenAI mode uses the Responses API with Structured Outputs and store:false.
 * - The model receives only the bounded V6.4 AI context plus a clinician task.
 * - The model may summarize / ask review questions / suggest non-executable review actions.
 * - It must never calculate nutrition facts, diagnose, prescribe, or directly mutate data.
 */

const OUTPUT_SCHEMA = {
  type:'object',
  additionalProperties:false,
  properties:{
    summary:{type:'string'},
    key_observations:{type:'array',items:{type:'string'},maxItems:6},
    questions_for_clinician:{type:'array',items:{type:'string'},maxItems:6},
    proposed_actions:{
      type:'array',maxItems:6,
      items:{
        type:'object',additionalProperties:false,
        properties:{
          type:{type:'string',enum:['REVIEW_FOLLOWUP','REVIEW_PLAN','REVIEW_CONSTRAINTS','COLLECT_DATA','INFO']},
          rationale:{type:'string'}
        },required:['type','rationale']
      }
    },
    safety_note:{type:'string'}
  },
  required:['summary','key_observations','questions_for_clinician','proposed_actions','safety_note']
};

const SYSTEM = [
  'You are the Newtrition clinician-assistant layer.',
  'Use only the supplied structured context. Do not invent facts, nutrition values, diagnoses, medications, or causal claims.',
  'Do not prescribe treatment, medical therapy, medication changes, or a diet plan. Do not calculate nutrition facts.',
  'You may summarize explicit information, identify review priorities, and suggest questions or non-executable review actions for a licensed clinician.',
  'The nutrition engine and database are the source of truth for nutrition values and plan decisions.',
  'Every output is a draft for clinician review, not an autonomous clinical decision.',
  'Return only the requested JSON structure.'
].join(' ');

function cleanText(v,max=1200){
  const s=String(v ?? '').trim();
  return s ? s.slice(0,max) : '';
}

function normalizeTask(task){
  const t=cleanText(task,1200);
  if(!t) throw Object.assign(new Error('task_required'),{status:400});
  return t;
}

function mockAssist({task,context}){
  const ds=context?.decision_support||{};
  const actions=(ds.actions||[]).slice(0,5).map(a=>({
    type:['SCHEDULE_FOLLOWUP','REVIEW_ADHERENCE'].includes(a.code)?'REVIEW_FOLLOWUP':
      ['REVIEW_PLAN_QUALITY','REVIEW_PLAN_RELEASE'].includes(a.code)?'REVIEW_PLAN':
      ['REVIEW_CONSTRAINT_CONFLICTS'].includes(a.code)?'REVIEW_CONSTRAINTS':'COLLECT_DATA',
    rationale:cleanText(a.action||a.code,400)
  }));
  return {
    summary:`مساعد Newtrition التجريبي: سألتَ عن «${cleanText(task,220)}». هذا ملخص مبني فقط على البيانات المنظمة المتاحة، وليس قرارًا سريريًا مستقلًا.`,
    key_observations:[
      context?.latest_plan?`آخر خطة: الإصدار ${context.latest_plan.version ?? '—'} وحالتها ${context.latest_plan.workflow_status || '—'}.`: 'لا توجد خطة حديثة متاحة في السياق.',
      ds.status?`حالة Decision Support الحالية: ${ds.status}.`:'لا توجد حالة Decision Support واضحة.',
      ...(context?.progress?.alerts||[]).slice(0,2).map(x=>cleanText(x.message||x.code,220))
    ].filter(Boolean).slice(0,6),
    questions_for_clinician:[
      'هل البيانات المتاحة كافية للإجابة عن المهمة الحالية؟',
      ...((ds.actions||[]).slice(0,3).map(a=>`هل تريد مراجعة: ${cleanText(a.action||a.code,180)}؟`))
    ].slice(0,6),
    proposed_actions:actions,
    safety_note:'مخرجات المساعد مسودة للمراجعة فقط؛ لا تشخيص، ولا وصف علاجي، ولا تغيير مباشر للخطة.'
  };
}

function extractStructured(response){
  if(!response) return null;
  if(typeof response.output_text==='string' && response.output_text.trim()){
    try{return JSON.parse(response.output_text);}catch{}
  }
  const output=Array.isArray(response.output)?response.output:[];
  for(const item of output){
    const content=Array.isArray(item.content)?item.content:[];
    for(const part of content){
      if(part.type==='output_text' && typeof part.text==='string'){
        try{return JSON.parse(part.text);}catch{}
      }
    }
  }
  return null;
}

function buildOpenAIRequest({task,context,model}){
  return {
    model:model || process.env.OPENAI_MODEL || 'gpt-5.6',
    store:false,
    input:[
      {role:'system',content:[{type:'input_text',text:SYSTEM}]},
      {role:'user',content:[{type:'input_text',text:JSON.stringify({task,context})}]}
    ],
    text:{format:{type:'json_schema',name:'newtrition_clinician_assistant',strict:true,schema:OUTPUT_SCHEMA}}
  };
}

async function openAI({task,context}){
  const key=process.env.OPENAI_API_KEY;
  if(!key) throw Object.assign(new Error('ai_provider_not_configured'),{status:503});
  const model=process.env.OPENAI_MODEL || 'gpt-5.6';
  const body=buildOpenAIRequest({task,context,model});
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const raw=await r.text();
  if(!r.ok){
    let msg='ai_provider_error';
    try{const j=JSON.parse(raw); msg=j?.error?.message||msg;}catch{}
    throw Object.assign(new Error(msg),{status:502});
  }
  let data;
  try{data=JSON.parse(raw);}catch{throw Object.assign(new Error('ai_invalid_response'),{status:502});}
  const result=extractStructured(data);
  if(!result) throw Object.assign(new Error('ai_unstructured_response'),{status:502});
  return {result,provider:'openai',model};
}

async function assist({task,context}){
  const normalized=normalizeTask(task);
  const provider=(process.env.NEWTRITION_AI_PROVIDER||'mock').toLowerCase();
  if(provider==='openai'){
    const r=await openAI({task:normalized,context});
    return {task:normalized,provider:r.provider,model:r.model,result:r.result,schema:'v6.5-ai-assistant-1'};
  }
  if(provider!=='mock') throw Object.assign(new Error('unsupported_ai_provider'),{status:500});
  return {task:normalized,provider:'mock',model:null,result:mockAssist({task:normalized,context}),schema:'v6.5-ai-assistant-1'};
}

function outputSchema(){return OUTPUT_SCHEMA;}
module.exports={assist,outputSchema,normalizeTask,mockAssist,buildOpenAIRequest};
