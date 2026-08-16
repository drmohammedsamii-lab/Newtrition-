const dayNames = ['السبت','الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة'];

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function n(v){ return v == null ? null : Number(v); }
function sum(items, key){
  const vals = items.map(x => n(x[key])).filter(v => v != null && Number.isFinite(v));
  return vals.reduce((a,b)=>a+b,0);
}
function fmt(v, d=0){ return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d); }

function buildShoppingList(days){
  const map = new Map();
  for(const day of days){
    for(const item of (day.items || [])){
      const key = item.canonical_id || `custom:${item.name_ar || item.custom_name || item.slot}`;
      const existing = map.get(key) || {
        key,
        canonical_id: item.canonical_id || null,
        name_ar: item.name_ar || item.custom_name || item.slot,
        brand: item.brand || null,
        portion_label: item.portion_label || null,
        qty: 0,
        uses: []
      };
      existing.qty += Number(item.qty || 1);
      existing.uses.push(day.day_name || dayNames[day.day_index] || String(day.day_index));
      map.set(key, existing);
    }
  }
  return [...map.values()].sort((a,b)=>a.name_ar.localeCompare(b.name_ar,'ar'));
}

function buildWhatsapp(doc){
  const lines = [];
  lines.push(`Newtrition — ${doc.client.full_name}`);
  lines.push(`الخطة: ${doc.plan.label || `v${doc.plan.version}`}`);
  if(doc.plan.target_kcal != null) lines.push(`الهدف: ${fmt(doc.plan.target_kcal)} kcal`);
  if(doc.plan.target_protein_g != null) lines.push(`بروتين: ${fmt(doc.plan.target_protein_g)} g`);
  lines.push('');
  for(const day of doc.days){
    lines.push(`📅 ${day.day_name}${day.day_type ? ` — ${day.day_type}` : ''}`);
    for(const item of day.items){
      const qty = item.qty && Number(item.qty)!==1 ? ` ×${item.qty}` : '';
      lines.push(`• ${item.slot}: ${item.name_ar}${qty}${item.portion_label ? ` (${item.portion_label})` : ''}`);
    }
    const t = day.totals;
    lines.push(`  الإجمالي: ${fmt(t.kcal)} kcal · P ${fmt(t.protein_g,1)}g · C ${fmt(t.carb_g,1)}g · F ${fmt(t.fat_g,1)}g`);
    lines.push('');
  }
  lines.push('🔄 البدائل المتاحة موضحة داخل البرنامج حسب الـevidence والقيود.');
  if(doc.notes.length){
    lines.push('');
    lines.push('ملاحظات:');
    doc.notes.forEach(x=>lines.push(`• ${x}`));
  }
  return lines.join('\n');
}

function buildPrintHtml(doc){
  const totals = doc.week_totals;
  const notes = doc.notes.length ? `<section><h2>ملاحظات سريرية</h2><ul>${doc.notes.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>` : '';
  const shopping = doc.shopping.length ? `<section><h2>قائمة المشتريات</h2><table><thead><tr><th>الصنف</th><th>الكمية</th><th>المرات</th></tr></thead><tbody>${doc.shopping.map(x=>`<tr><td>${esc(x.name_ar)}${x.brand?` — ${esc(x.brand)}`:''}</td><td>${fmt(x.qty, x.qty%1?1:0)}</td><td>${esc([...new Set(x.uses)].join('، '))}</td></tr>`).join('')}</tbody></table></section>` : '';
  const days = doc.days.map(day=>{
    const t = day.totals;
    return `<section class="day"><div class="day-head"><h2>${esc(day.day_name)}</h2><span>${esc(day.day_type||'')}</span></div>
      <table><thead><tr><th>الوجبة</th><th>الدور</th><th>الحصة</th><th>السعرات</th><th>البروتين</th><th>الدليل</th></tr></thead><tbody>
      ${day.items.map(i=>`<tr><td><b>${esc(i.name_ar)}</b><div class="muted">${esc(i.slot)}</div></td><td>${esc(i.food_role||'')}</td><td>${esc(i.portion_label||'')}</td><td>${fmt(i.kcal)}</td><td>${fmt(i.protein_g,1)} g</td><td>${esc(i.evidence_tier||'unknown')}</td></tr>`).join('')}
      </tbody></table><div class="day-total">إجمالي اليوم: ${fmt(t.kcal)} kcal · P ${fmt(t.protein_g,1)}g · C ${fmt(t.carb_g,1)}g · F ${fmt(t.fat_g,1)}g · Fiber ${fmt(t.fiber_g,1)}g</div></section>`;
  }).join('');

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Newtrition — ${esc(doc.client.full_name)}</title>
  <style>body{font-family:Arial,"Segoe UI",sans-serif;background:#f5f7f6;color:#13211f;margin:0;padding:24px;line-height:1.6}.sheet{max-width:980px;margin:auto;background:#fff;padding:28px;border:1px solid #dfe7e5}.top{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #1a8a80;padding-bottom:16px;margin-bottom:20px}.brand{font-size:22px;font-weight:800;color:#0f3d3e}.muted{font-size:12px;color:#6d7d79}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:15px 0}.box{background:#e8f3f1;border-radius:8px;padding:10px;text-align:center}.box b{display:block;font-size:18px;color:#0f3d3e}.box span{font-size:11px;color:#41544f}.day{margin-top:20px}.day-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.day-head h2{margin:0;color:#0f3d3e;font-size:16px}.day-head span{font-size:11px;color:#7b8d88}.day-total{margin-top:8px;background:#f0f5f3;padding:8px;border-radius:6px;font-weight:700;font-size:12px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border-bottom:1px solid #edf1f0;padding:7px;text-align:right;vertical-align:top}th{color:#71817d;font-size:11px}section{margin-top:24px}section h2{color:#0f3d3e;font-size:15px}@media print{body{background:#fff;padding:0}.sheet{border:0;max-width:none;padding:10px}.no-print{display:none!important}.day{break-inside:avoid}}button{padding:8px 12px;border:0;border-radius:6px;cursor:pointer}.actions{margin-bottom:18px}</style></head><body><div class="sheet"><div class="actions no-print"><button onclick="window.print()">🖨️ طباعة / حفظ PDF</button><button onclick="window.close()">إغلاق</button></div>
  <div class="top"><div><div class="brand">Newtrition</div><div class="muted">مخطط غذائي إكلينيكي</div></div><div><b>${esc(doc.client.full_name)}</b><div class="muted">${esc(doc.plan.label || `Plan v${doc.plan.version}`)}</div></div></div>
  <div class="summary"><div class="box"><b>${fmt(doc.plan.target_kcal)}</b><span>kcal target</span></div><div class="box"><b>${fmt(doc.plan.target_protein_g,1)}</b><span>Protein g</span></div><div class="box"><b>${fmt(totals.kcal)}</b><span>Week kcal</span></div><div class="box"><b>${fmt(doc.quality.score,1)}</b><span>Quality score</span></div></div>
  ${days}${shopping}${notes}</div></body></html>`;
}

async function loadPlanDocument(pool, planId, clinicianId, getPlanOwner){
  const owned = await getPlanOwner(pool, planId, clinicianId);
  if(!owned) return null;
  const planQ = await pool.query(`SELECT p.*, c.full_name, c.gender, c.birth_year, c.height_cm, c.goal, c.conditions, c.medications, c.gi_notes, c.habits, c.sleep, c.stress
    FROM plan p JOIN client c ON c.id=p.client_id WHERE p.id=$1`, [planId]);
  if(!planQ.rows.length) return null;
  const p = planQ.rows[0];
  const daysQ = await pool.query(`SELECT pd.id, pd.day_index, pd.day_name, pd.day_type,
    COALESCE(jsonb_agg(jsonb_build_object(
      'id',pi.id,'slot',pi.slot,'qty',pi.qty,'is_locked',pi.is_locked,'canonical_id',f.canonical_id,
      'name_ar',COALESCE(f.name_ar,pi.custom_name),'brand',f.brand,'portion_label',f.portion_label,
      'food_role',f.food_role,'category',f.category,'kcal',ns.kcal,'protein_g',ns.protein_g,'carb_g',ns.carb_g,
      'fat_g',ns.fat_g,'fiber_g',ns.fiber_g,'evidence_tier',e.tier,'status',ns.status,'custom_kcal',pi.custom_kcal
    ) ORDER BY pi.position,pi.id) FILTER (WHERE pi.id IS NOT NULL),'[]'::jsonb) items
    FROM plan_day pd LEFT JOIN plan_item pi ON pi.plan_day_id=pd.id LEFT JOIN food_item f ON f.id=pi.food_item_id
    LEFT JOIN nutrition_serving ns ON ns.food_item_id=f.id LEFT JOIN evidence e ON e.food_item_id=f.id
    WHERE pd.plan_id=$1 GROUP BY pd.id ORDER BY pd.day_index`, [planId]);

  const days = daysQ.rows.map(d=>{
    const items = d.items || [];
    return {...d, items, totals:{kcal:sum(items,'kcal'),protein_g:sum(items,'protein_g'),carb_g:sum(items,'carb_g'),fat_g:sum(items,'fat_g'),fiber_g:sum(items,'fiber_g')}};
  });
  const weekTotals = days.reduce((a,d)=>({kcal:a.kcal+d.totals.kcal,protein_g:a.protein_g+d.totals.protein_g,carb_g:a.carb_g+d.totals.carb_g,fat_g:a.fat_g+d.totals.fat_g,fiber_g:a.fiber_g+d.totals.fiber_g}),{kcal:0,protein_g:0,carb_g:0,fat_g:0,fiber_g:0});
  const notes = [
    p.conditions && `حالات: ${p.conditions}`,
    p.medications && `أدوية/مكملات: ${p.medications}`,
    p.gi_notes && `GI: ${p.gi_notes}`,
    p.habits && `عادات: ${p.habits}`,
    p.sleep && `النوم: ${p.sleep}`,
    p.stress && `التوتر: ${p.stress}`,
    p.quality_warnings && JSON.parse(p.quality_warnings || '[]').length ? `تحذيرات الجودة: ${JSON.parse(p.quality_warnings || '[]').join('، ')}` : null
  ].filter(Boolean);
  const shopping = buildShoppingList(days);
  return {client:{id:p.client_id,full_name:p.full_name,gender:p.gender,birth_year:p.birth_year,height_cm:p.height_cm,goal:p.goal},plan:p,days,week_totals:weekTotals,shopping,notes,quality:{score:n(p.quality_score)||0,status:p.quality_status||'UNKNOWN',blockers:JSON.parse(p.quality_blockers||'[]'),warnings:JSON.parse(p.quality_warnings||'[]')}};
}

module.exports = { loadPlanDocument, buildWhatsapp, buildPrintHtml, buildShoppingList };
