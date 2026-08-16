/**
 * Newtrition V6.4 — AI Context Builder.
 *
 * This module prepares a deterministic, bounded context object for an external
 * AI layer. It does NOT call a model, infer diagnoses, or invent nutrition facts.
 * Only explicit database/application outputs are included.
 */

function safeNumber(v){
  if(v===null || v===undefined || v==='') return null;
  const n=Number(v); return Number.isFinite(n)?n:null;
}
function cleanText(v,max=500){
  if(v===null || v===undefined) return null;
  const s=String(v).trim();
  return s ? s.slice(0,max) : null;
}
function uniq(xs){ return [...new Set((xs||[]).filter(Boolean).map(String))].slice(0,100); }

function build({client, constraints=[], policy=null, workspace=null, progress=null, decisionSupport=null, latestPlan=null}){
  const c=client||{};
  const ws=workspace||{};
  const lp=latestPlan||ws.latest_plan||null;
  const safeClient={
    id:c.id ?? null,
    full_name:cleanText(c.full_name,120),
    gender:cleanText(c.gender,30),
    birth_year:safeNumber(c.birth_year),
    height_cm:safeNumber(c.height_cm),
    goal:cleanText(c.goal,120)
  };

  const safeConstraints=(constraints||[]).map(x=>({
    type:cleanText(x.type,60),
    value:cleanText(x.value,160),
    source:cleanText(x.source||'clinician',60),
    active:x.active!==false
  })).filter(x=>x.type&&x.active).slice(0,100);

  const latestPlanSummary=lp?{
    id:lp.id ?? null,
    version:safeNumber(lp.version),
    workflow_status:cleanText(lp.workflow_status,30),
    is_released:Boolean(lp.is_released),
    quality_score:safeNumber(lp.quality_score),
    quality_status:cleanText(lp.quality_status,30),
    optimizer_version:cleanText(lp.optimizer_version,80),
    target_kcal:safeNumber(lp.target_kcal),
    target_protein_g:safeNumber(lp.target_protein_g),
    created_at:lp.created_at||null,
    approved_at:lp.approved_at||null
  }:null;

  return {
    schema_version:'v6.4-ai-context-1',
    purpose:'structured_decision_support_context',
    generated_at:new Date().toISOString(),
    safety:{
      no_diagnosis:true,
      no_prescription:true,
      no_causal_claims:true,
      nutrition_source_of_truth:'newtrition_engine_and_database',
      ai_role:'interpret_and_summarize_explicit_context_only',
      clinician_approval_required:true
    },
    client:safeClient,
    explicit_constraints:safeConstraints,
    policy:policy||null,
    latest_plan:latestPlanSummary,
    progress:progress||ws.progress||null,
    followup_intelligence:workspace?.intelligence||null,
    decision_support:decisionSupport||ws.decision_support||null,
    requested_tasks:[],
    excluded_raw_fields:['password_hash','session_token','audit_ip','free_form_medical_notes_by_default']
  };
}

module.exports={build};
