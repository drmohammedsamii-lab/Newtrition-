/**
 * Newtrition V6.2 — Progress / Plan Correlation (descriptive, not causal).
 *
 * This module compares follow-up observations with the time window of the latest
 * plan. It MUST NOT claim that a plan caused a change. It only reports what was
 * observed during the plan period and flags data-quality/decision-support points.
 */
const DAY_MS = 86400000;

function finite(v){ return v !== null && v !== undefined && Number.isFinite(Number(v)); }
function num(v){ return finite(v) ? Number(v) : null; }
function dateOnly(v){ return v ? String(v).slice(0,10) : null; }
function daysBetween(a,b){
  if(!a || !b) return null;
  return Math.max(0,(new Date(`${a}T00:00:00Z`)-new Date(`${b}T00:00:00Z`))/DAY_MS);
}
function mean(values){
  const xs = values.filter(v=>v!==null && Number.isFinite(v));
  return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
}
function firstValue(rows,key){
  const x=rows.find(r=>finite(r[key]));
  return x ? num(x[key]) : null;
}
function lastValue(rows,key){
  for(let i=rows.length-1;i>=0;i--) if(finite(rows[i][key])) return num(rows[i][key]);
  return null;
}

function correlate({followups=[], latestPlan=null}){
  const items=[...followups]
    .filter(x=>x && x.visit_date)
    .sort((a,b)=>String(a.visit_date).localeCompare(String(b.visit_date)) || Number(a.id||0)-Number(b.id||0));

  if(!latestPlan){
    return {
      status:'NO_PLAN',
      plan_period:null,
      observations:{followups:items.length,followups_in_plan_period:0,weight_change:null,waist_change:null,body_fat_change:null,avg_adherence:null},
      quality:{score:null,status:null},
      alerts:[{code:'NO_CURRENT_PLAN',severity:'INFO',message:'لا توجد خطة حالية لمقارنة المتابعة بها.'}],
      summary:'لا توجد خطة حالية؛ اعرض الاتجاهات والمتابعة دون نسبة التغير إلى خطة.'
    };
  }

  const planStart=dateOnly(latestPlan.created_at || latestPlan.approved_at);
  const inPeriod = planStart ? items.filter(x=>String(x.visit_date).slice(0,10)>=planStart) : [];
  const periodRows = inPeriod.length ? inPeriod : items;
  const firstWeight=firstValue(periodRows,'weight_kg');
  const lastWeight=lastValue(periodRows,'weight_kg');
  const firstWaist=firstValue(periodRows,'waist_cm');
  const lastWaist=lastValue(periodRows,'waist_cm');
  const firstBodyFat=firstValue(periodRows,'body_fat_pct');
  const lastBodyFat=lastValue(periodRows,'body_fat_pct');
  const avgAdherence=mean(periodRows.map(x=>num(x.adherence_pct)));
  const firstDate=periodRows[0]?.visit_date ? dateOnly(periodRows[0].visit_date) : null;
  const lastDate=periodRows.at(-1)?.visit_date ? dateOnly(periodRows.at(-1).visit_date) : null;
  const periodDays=daysBetween(lastDate,firstDate);

  const alerts=[];
  if(!planStart) alerts.push({code:'PLAN_DATE_UNAVAILABLE',severity:'LOW',message:'تاريخ بداية الخطة غير متاح؛ المقارنة تستخدم بيانات المتابعة المتاحة فقط.'});
  if(periodRows.length<2) alerts.push({code:'INSUFFICIENT_PROGRESS_DATA',severity:'MEDIUM',message:'توجد متابعة واحدة أو أقل داخل فترة الخطة؛ لا يمكن تقييم اتجاه التغير بثقة.'});
  if(avgAdherence!==null && avgAdherence<70) alerts.push({code:'LOW_ADHERENCE_IN_PLAN_PERIOD',severity:'MEDIUM',message:`متوسط الالتزام أثناء فترة المقارنة حوالي ${avgAdherence.toFixed(0)}%.`});
  if(latestPlan.workflow_status!=='APPROVED' || !latestPlan.is_released){
    alerts.push({code:'PLAN_NOT_RELEASED',severity:'LOW',message:'الخطة الحالية غير معتمدة/غير متاحة؛ المقارنة لا تعني تقييم فعالية خطة سريرية منشورة.'});
  }
  if(latestPlan.quality_status && latestPlan.quality_status!=='PASS'){
    alerts.push({code:'PLAN_QUALITY_NOT_PASS',severity:'MEDIUM',message:`آخر جودة محفوظة للخطة ليست PASS (${latestPlan.quality_status}).`});
  }

  const weightChange=(firstWeight!==null && lastWeight!==null)?lastWeight-firstWeight:null;
  const waistChange=(firstWaist!==null && lastWaist!==null)?lastWaist-firstWaist:null;
  const bodyFatChange=(firstBodyFat!==null && lastBodyFat!==null)?lastBodyFat-firstBodyFat:null;

  let status='OBSERVATION_ONLY';
  if(periodRows.length>=2){
    if(avgAdherence!==null && avgAdherence<70) status='REVIEW_RECOMMENDED';
    else if(latestPlan.workflow_status==='APPROVED' && latestPlan.is_released && latestPlan.quality_status==='PASS') status='TRACKING';
  }

  return {
    status,
    plan_period:{plan_id:latestPlan.id,version:latestPlan.version,workflow_status:latestPlan.workflow_status,is_released:Boolean(latestPlan.is_released),created_at:latestPlan.created_at||null,start_date:planStart,quality_score:num(latestPlan.quality_score),quality_status:latestPlan.quality_status||null,optimizer_version:latestPlan.optimizer_version||null,target_kcal:num(latestPlan.target_kcal),target_protein_g:num(latestPlan.target_protein_g)},
    observations:{followups:items.length,followups_in_plan_period:periodRows.length,first_followup:firstDate,last_followup:lastDate,period_days:periodDays,weight_change:weightChange,waist_change:waistChange,body_fat_change:bodyFatChange,avg_adherence:avgAdherence,latest_adherence:lastValue(periodRows,'adherence_pct')},
    alerts,
    summary: periodRows.length>=2
      ? 'هذا ملخص وصفي للمتابعة خلال فترة الخطة؛ لا يثبت أن الخطة سببت التغيرات الملاحظة.'
      : 'البيانات غير كافية للمقارنة الزمنية؛ استخدمها كنقطة متابعة وليس كاستنتاج عن فعالية الخطة.'
  };
}

module.exports={correlate};
