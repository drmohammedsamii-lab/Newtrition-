'use strict';

const CORE = ['kcal','protein_g','carb_g','fat_g'];

function finite(v){ return v !== null && v !== undefined && Number.isFinite(Number(v)); }

function missing(row){ return CORE.filter(k => !finite(row[k])); }

function commercialValue(row){
  // Heuristic only: used to order review work, never to approve nutrition data.
  let score = 0;
  if (row.source) score += 10;
  if (row.brand) score += 8;
  if (row.entity_type === 'PRODUCT') score += 8;
  if (row.entity_type === 'MEAL') score += 7;
  if (row.entity_type === 'RECIPE') score += 5;
  if (row.category === 'رئيسية') score += 8;
  if (row.category === 'فطار') score += 6;
  if (row.category === 'سناك') score += 4;
  return score;
}

function remediationFor(row){
  const evidence = String(row.evidence_tier || 'unknown').toLowerCase();
  const status = String(row.status || 'INCOMPLETE');
  const miss = missing(row);
  if (!row.is_active) return {
    action:'BLOCK', source_priority:'none', reason_codes:['inactive'],
    needs_value_edit:false, requires_human_source:true,
    note:'الصنف غير نشط؛ لا تحتاج تعديلًا غذائيًا قبل إعادة تفعيله.'
  };
  if (status === 'CONFLICT_REVIEW') return {
    action:'SOURCE_VERIFY_CONFLICT', source_priority:'high', reason_codes:['calorie_macro_conflict'],
    needs_value_edit:true, requires_human_source:true,
    note:'راجع الملصق/المصدر الأصلي وقارن السعرات بالماكروز؛ لا تعتمد أي قيمة آلية.'
  };
  if (miss.length) return {
    action:'FILL_CORE_MACROS_FROM_SOURCE', source_priority:'high', reason_codes:['missing_core_macros', ...miss.map(x=>`missing:${x}`)],
    needs_value_edit:true, requires_human_source:true,
    note:`القيم الناقصة: ${miss.join(', ')}. مطلوب مصدر موثوق قبل الإدخال.`
  };
  if (['estimated','unknown','missing'].includes(evidence)) return {
    action:'REPLACE_OR_VERIFY_EVIDENCE', source_priority:'high', reason_codes:[`evidence:${evidence}`],
    needs_value_edit:false, requires_human_source:true,
    note:'القيم كاملة لكن المصدر غير كافٍ للاعتماد التلقائي؛ استبدل المصدر أو اعتمد القيم بعد تحقق سريري.'
  };
  if (evidence === 'calculated') return {
    action:'VERIFY_CALCULATED_VALUES', source_priority:'medium', reason_codes:['evidence:calculated'],
    needs_value_edit:false, requires_human_source:false,
    note:'القيم محسوبة؛ تحتاج sign-off قبل رفعها إلى الثقة الأعلى.'
  };
  if (!finite(row.fiber_g)) return {
    action:'ADD_FIBER_IF_SOURCE_AVAILABLE', source_priority:'low', reason_codes:['missing_fiber'],
    needs_value_edit:true, requires_human_source:true,
    note:'الألياف ناقصة. يمكن إبقاء الصنف في warning lane، أو إضافة قيمة من مصدر موثوق.'
  };
  return {
    action:'CLINICAL_SPOT_CHECK', source_priority:'low', reason_codes:[],
    needs_value_edit:false, requires_human_source:false,
    note:'لا توجد مشكلة واضحة؛ يفضل spot-check قبل الاعتماد الكامل.'
  };
}

function rankScore(row, remediation){
  const priority = Number(row.priority || 0);
  const commercial = commercialValue(row);
  const clinical = row.food_role === 'PROTEIN' || row.food_role === 'COMPOSITE_MEAL' ? 8 : 0;
  const source = remediation.source_priority === 'high' ? 6 : remediation.source_priority === 'medium' ? 3 : 0;
  return priority * 10 + commercial + clinical + source;
}

function buildRemediation(row){
  const remediation = remediationFor(row);
  return {
    ...remediation,
    commercial_value: commercialValue(row),
    rank_score: rankScore(row, remediation)
  };
}

function summarize(rows){
  const out = {total:0, by_action:{}, high_value:0};
  for(const row of rows || []){
    out.total++;
    const r = buildRemediation(row);
    out.by_action[r.action] = (out.by_action[r.action] || 0) + 1;
    if(r.rank_score >= 900) out.high_value++;
  }
  return out;
}

module.exports = { CORE, missing, remediationFor, commercialValue, rankScore, buildRemediation, summarize };
