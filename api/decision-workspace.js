/**
 * Newtrition V6.3 — Clinician Decision Workspace.
 * Deterministic decision-support only. It prioritizes review actions from
 * existing alerts/progress/plan state; it does not diagnose or prescribe.
 */
function unique(list){ return [...new Set(list.filter(Boolean))]; }

function build({intelligence={}, progress={}, latestPlan=null, conflictingReviewItems=0, nowMs=Date.now()}){
  const actions=[];
  const blockers=[];
  const alerts=[...(intelligence.alerts||[]), ...(progress.alerts||[])];

  for(const a of alerts){
    if(!a) continue;
    if(a.code==='FOLLOWUP_OVERDUE') actions.push({priority:'HIGH',code:'SCHEDULE_FOLLOWUP',action:'Schedule a follow-up and review the latest measurements.',source:a.code});
    else if(a.code==='FOLLOWUP_DUE') actions.push({priority:'MEDIUM',code:'SCHEDULE_FOLLOWUP',action:'Schedule the next follow-up.',source:a.code});
    else if(a.code==='ADHERENCE_DROP') actions.push({priority:'MEDIUM',code:'REVIEW_ADHERENCE',action:'Review adherence barriers before changing the plan.',source:a.code});
    else if(a.code==='LOW_RECENT_ADHERENCE' || a.code==='LOW_ADHERENCE_IN_PLAN_PERIOD') actions.push({priority:'MEDIUM',code:'REVIEW_ADHERENCE',action:'Review adherence, implementation barriers, and client feedback.',source:a.code});
    else if(a.code==='WEIGHT_FLAT') actions.push({priority:'MEDIUM',code:'REVIEW_PROGRESS_CONTEXT',action:'Review adherence, measurements, and context before changing targets.',source:a.code});
    else if(a.code==='PLAN_NOT_RELEASED') actions.push({priority:'LOW',code:'REVIEW_PLAN_RELEASE',action:'Review plan workflow status before treating it as the active clinical plan.',source:a.code});
    else if(a.code==='PLAN_QUALITY_NOT_PASS') actions.push({priority:'HIGH',code:'REVIEW_PLAN_QUALITY',action:'Review the plan quality blockers/warnings before approval.',source:a.code});
    else if(a.code==='INSUFFICIENT_PROGRESS_DATA') actions.push({priority:'LOW',code:'COLLECT_MORE_DATA',action:'Collect additional follow-up data before drawing a trend conclusion.',source:a.code});
  }

  if(Number(conflictingReviewItems)>0){
    blockers.push({priority:'HIGH',code:'CONFLICTING_REVIEW_ITEMS',action:`${conflictingReviewItems} food-review item(s) conflict with the client constraints.`});
    actions.push({priority:'HIGH',code:'REVIEW_CONSTRAINT_CONFLICTS',action:'Resolve client-constraint-related food review conflicts before approving a plan.',source:'REVIEW_QUEUE'});
  }

  if(latestPlan && latestPlan.workflow_status==='APPROVED' && latestPlan.is_released===true){
    actions.push({priority:'INFO',code:'PLAN_ACTIVE',action:'Current plan is approved and released.',source:'PLAN_STATUS'});
  }

  const order={HIGH:0,MEDIUM:1,LOW:2,INFO:3};
  const dedup=new Map();
  for(const a of actions){
    const prev=dedup.get(a.code);
    if(!prev || order[a.priority]<order[prev.priority]) dedup.set(a.code,a);
  }
  const finalActions=[...dedup.values()].sort((a,b)=>order[a.priority]-order[b.priority] || a.code.localeCompare(b.code));

  const status = finalActions.some(a=>a.priority==='HIGH') ? 'ACTION_REQUIRED'
    : finalActions.some(a=>a.priority==='MEDIUM') ? 'REVIEW_RECOMMENDED'
    : finalActions.some(a=>a.priority==='LOW') ? 'MONITOR'
    : 'STABLE';

  return {
    version:'v6.3-decision-workspace-1',
    status,
    actions:finalActions,
    blockers,
    summary: status==='ACTION_REQUIRED' ? 'توجد إجراءات أولوية عالية تحتاج مراجعة إكلينيكية.'
      : status==='REVIEW_RECOMMENDED' ? 'توجد نقاط يفضل مراجعتها قبل تغيير الخطة.'
      : status==='MONITOR' ? 'لا توجد مشكلة أولوية عالية؛ توجد نقاط متابعة منخفضة الأولوية.'
      : 'لا توجد إجراءات مراجعة آلية واضحة حاليًا.',
    generated_at:new Date(nowMs).toISOString(),
    observation_only:true
  };
}

module.exports={build};
