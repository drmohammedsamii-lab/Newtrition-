/**
 * Newtrition V6.0 — Follow-up Intelligence
 * Deterministic decision support only. It describes trends and flags review points;
 * it does not diagnose or prescribe.
 */
const DAY_MS = 86400000;

function finite(v){ return v !== null && v !== undefined && Number.isFinite(Number(v)); }
function num(v){ return finite(v) ? Number(v) : null; }
function mean(values){ const xs=values.filter(v=>v!==null); return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; }
function daysBetween(a,b){ return Math.max(0,(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/DAY_MS); }

function analyze(rows){
  const items = [...rows].sort((a,b)=>String(a.visit_date).localeCompare(String(b.visit_date)) || Number(a.id)-Number(b.id));
  const latest = items.at(-1) || null;
  const previous = items.at(-2) || null;
  const weights = items.map(x=>({date:String(x.visit_date), value:num(x.weight_kg)})).filter(x=>x.value!==null);
  const waist = items.map(x=>({date:String(x.visit_date), value:num(x.waist_cm)})).filter(x=>x.value!==null);
  const bodyFat = items.map(x=>({date:String(x.visit_date), value:num(x.body_fat_pct)})).filter(x=>x.value!==null);
  const adher = items.map(x=>num(x.adherence_pct)).filter(v=>v!==null);
  const trend = (series)=>{
    if(series.length<2) return {available:false};
    const first=series[0], last=series.at(-1), delta=last.value-first.value;
    const days=daysBetween(first.date,last.date);
    return {available:true,start:first,end:last,delta,percent:first.value ? delta/first.value*100:null,per_week:days>0?delta/(days/7):delta};
  };
  const alerts=[];
  if(!latest){ return {status:'NO_DATA', followups:0, alerts:[], latest:null, trends:{weight:{available:false},waist:{available:false},body_fat:{available:false}}, adherence:{avg:null,latest:null,delta:null}, summary:'لا توجد بيانات متابعة.'}; }
  const latestDate=new Date(String(latest.visit_date)+'T00:00:00Z');
  const ageDays=Math.max(0,Math.floor((Date.now()-latestDate.getTime())/DAY_MS));
  if(ageDays>=30) alerts.push({code:'FOLLOWUP_OVERDUE',severity:'HIGH',message:'لم تتم إضافة متابعة خلال 30 يومًا.'});
  else if(ageDays>=14) alerts.push({code:'FOLLOWUP_DUE',severity:'MEDIUM',message:'مر أكثر من أسبوعين منذ آخر متابعة.'});
  if(previous && finite(latest.adherence_pct) && finite(previous.adherence_pct)){
    const d=num(latest.adherence_pct)-num(previous.adherence_pct);
    if(d<=-15) alerts.push({code:'ADHERENCE_DROP',severity:'MEDIUM',message:`انخفض الالتزام بمقدار ${Math.abs(d).toFixed(0)} نقطة مئوية منذ المتابعة السابقة.`});
  }
  const wt=trend(weights), wa=trend(waist), bf=trend(bodyFat);
  if(wt.available && Math.abs(wt.delta)<0.2 && items.length>=3) alerts.push({code:'WEIGHT_FLAT',severity:'MEDIUM',message:'الوزن شبه ثابت عبر آخر المتابعات؛ راجع الالتزام والسياق قبل تغيير الخطة.'});
  const recent=items.slice(-3);
  const recentAd=mean(recent.map(x=>num(x.adherence_pct)));
  if(recent.length>=2 && recentAd!==null && recentAd<70) alerts.push({code:'LOW_RECENT_ADHERENCE',severity:'MEDIUM',message:`متوسط الالتزام في آخر المتابعات حوالي ${recentAd.toFixed(0)}%.`});
  const severe=alerts.some(a=>a.severity==='HIGH');
  const status=severe?'REVIEW_URGENT':alerts.length?'REVIEW_RECOMMENDED':'STABLE';
  return {
    status, followups:items.length, alerts, latest,
    age_days_since_latest:ageDays,
    trends:{weight:wt,waist:wa,body_fat:bf},
    adherence:{avg:mean(adher),latest:num(latest.adherence_pct),delta:(previous&&finite(latest.adherence_pct)&&finite(previous.adherence_pct))?num(latest.adherence_pct)-num(previous.adherence_pct):null},
    summary: status==='STABLE' ? 'المتابعة الحالية مستقرة نسبيًا؛ لا توجد إشارة مراجعة آلية واضحة.' : 'توجد نقاط تحتاج مراجعة إكلينيكية قبل تغيير الخطة.'
  };
}

module.exports={analyze};
