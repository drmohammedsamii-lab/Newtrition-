
const API = location.origin + '/api';
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}
function enc(v){return encodeURIComponent(String(v??''));}
const SLOTS = [
  {key:'فطار',   pct:.25, role:null},
  {key:'سناك ١', pct:.10, role:null},
  {key:'غداء',   pct:.35, role:null},
  {key:'سناك ٢', pct:.10, role:null},
  {key:'عشاء',   pct:.20, role:null}
];
let targets = null, activeSlot = 'فطار';
const plan = {};                       // slot -> item
SLOTS.forEach(s => plan[s.key] = null);

/* ---------- plumbing ---------- */
async function api(path, opts){
  const o = Object.assign({credentials:'same-origin', headers:{}}, opts||{});
  o.headers['X-Requested-With'] = 'newtrition';          // blocks cross-site posts
  if(o.body) o.headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, o);
  if(r.status === 401){ showGate(); throw new Error('auth_required'); }
  if(!r.ok){
    let msg = 'request_failed';
    try { msg = (await r.json()).message || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
function num(v){ return v===null||v===undefined ? null : Number(v); }
function fmt(v,d=0){ return v===null ? '—' : Number(v).toFixed(d); }

function showGate(){ gate.style.display='flex'; who.style.display='none'; }
function hideGate(){ gate.style.display='none'; }

async function checkApi(){
  const el = document.getElementById('apiStatus');
  try { await api('/health'); el.textContent='متصل'; el.classList.remove('down'); }
  catch { el.textContent='الخادم غير متاح'; el.classList.add('down'); }
}

async function checkSession(){
  try{
    const me = await fetch(API+'/auth/me',{credentials:'same-origin'});
    if(!me.ok){ showGate(); return false; }
    const u = await me.json();
    whoName.textContent = u.full_name;
    who.style.display='flex'; hideGate(); checkApi();
    loadDashboard();
    return true;
  }catch{ showGate(); return false; }
}

async function login(){
  lgErr.textContent=''; lgBtn.disabled=true; lgBtn.textContent='جارٍ الدخول…';
  try{
    await api('/auth/login',{method:'POST',
      body: JSON.stringify({email:lgEmail.value.trim(), password:lgPass.value})});
    lgPass.value=''; await checkSession();
  }catch(e){ lgErr.textContent = e.message==='request_failed'
      ? 'تعذر الاتصال بالخادم' : e.message; }
  finally{ lgBtn.disabled=false; lgBtn.textContent='دخول'; }
}

async function logout(){
  try{ await api('/auth/logout',{method:'POST'}); }catch{}
  location.reload();
}

/* ---------- targets ---------- */
function calcTargets(){
  const age=+cAge.value, ht=+cHt.value, wt=+cWt.value, act=+cAct.value, adj=+cGoal.value;
  const male = cSex.value==='male';
  if(!age||!ht||!wt){ alert('اكمل السن والطول والوزن'); return; }

  const bmr = Math.round(10*wt + 6.25*ht - 5*age + (male?5:-161));   // Mifflin-St Jeor
  const tdee = Math.round(bmr*act);
  const kcal = Math.round(tdee*(1+adj));
  const protein = Math.round(wt * (+cProt.value||1.6));
  const fat = Math.round(wt*0.8);
  const carb = Math.max(0, Math.round((kcal - protein*4 - fat*9)/4));
  const fiber = Math.round(kcal/1000*14);
  targets = {kcal,protein,carb,fat,fiber,bmr,tdee};

  const floor = male?1500:1200;
  const warn = kcal < floor
    ? `<div class="note" style="color:var(--flag)">الهدف ${kcal} سعرة تحت الحد المتعارف عليه (${floor}). راجع نسبة العجز.</div>` : '';

  const out = document.getElementById('calcOut');
  out.style.display='block';
  out.innerHTML = `<span class="big">${kcal} سعرة</span>
    <b>BMR</b> ${bmr} · <b>TDEE</b> ${tdee}<br>
    <b>بروتين</b> ${protein}جم · <b>كارب</b> ${carb}جم · <b>دهون</b> ${fat}جم · <b>ألياف</b> ${fiber}جم${warn}`;
  buildSlots(); renderPlan();
}

function buildSlots(){
  slotBar.innerHTML = SLOTS.map(s =>
    `<button class="${s.key===activeSlot?'on':''}" onclick="pickSlot('${s.key}')">${s.key}</button>`).join('');
}
function pickSlot(k){ activeSlot=k; buildSlots(); openPicker(k); }

/* ---------- suggestions ---------- */
async function openPicker(slotKey){
  if(!targets){ alert('احسب الأهداف الأول'); return; }
  const slot = SLOTS.find(s=>s.key===slotKey);
  const kcal = Math.round(targets.kcal*slot.pct);
  const prot = Math.round(targets.protein*slot.pct);
  const excl = cExcl.value.split('،').map(x=>x.trim()).filter(Boolean).join(',');

  showModal(`<h3>اختر صنف لـ${slotKey} · حوالي ${kcal} سعرة</h3><div class="empty">جارٍ البحث…</div>`);
  try{
    const d = await api(`/suggest?kcal=${kcal}&protein=${prot}&exclude=${encodeURIComponent(excl)}`);
    if(!d.candidates.length){ showModal(`<h3>${slotKey}</h3><div class="empty">لا توجد أصناف مناسبة. جرب توسيع نطاق السعرات أو تقليل الاستبعادات.</div>`); return; }
    showModal(`<h3>اختر صنف لـ${slotKey} · حوالي ${kcal} سعرة و${prot}جم بروتين</h3>` +
      d.candidates.map(c=>`
        <div class="srow">
          <div>
            <b>${c.name_ar}</b> <span class="role">${c.food_role}</span>
            <span class="tier ${c.evidence_tier}">${c.evidence_tier}</span>
            <div class="diff">${fmt(c.kcal)} سعرة · بروتين ${fmt(c.protein_g,1)}جم · ${c.category||''}</div>
          </div>
          <button class="ghost" onclick='choose(${JSON.stringify(JSON.stringify(c))})'>اختر</button>
        </div>`).join(''));
  }catch(e){ showModal(`<h3>خطأ</h3><div class="empty">تعذر تحميل الاقتراحات. تأكد أن الخادم شغال.</div>`); }
}

function choose(json){ plan[activeSlot] = JSON.parse(json); closeModal(); renderPlan(); }

async function swap(slotKey){
  const it = plan[slotKey]; if(!it) return;
  showModal(`<h3>بدائل لـ${it.name_ar}</h3><div class="empty">جارٍ البحث…</div>`);
  const d = await api(`/foods/${it.canonical_id}/substitutes?limit=12`);
  if(!d.substitutes.length){ showModal(`<h3>بدائل لـ${it.name_ar}</h3>
     <div class="empty">لا يوجد بديل بنفس الدور الغذائي (${it.food_role}) وفي نطاق السعرات والبروتين.</div>`); return; }
  showModal(`<h3>بدائل لـ${it.name_ar} <span class="role">${it.food_role}</span></h3>
    <div class="note" style="margin-bottom:10px">البدائل بنفس الدور الغذائي فقط، وبروتين لا يقل عن 70% من الأصلي.</div>` +
    d.substitutes.map(s=>`
      <div class="srow">
        <div><b>${s.name_ar}</b> <span class="tier ${s.evidence_tier}">${s.evidence_tier}</span>
          <div class="diff">${fmt(s.kcal)} سعرة · بروتين ${fmt(s.protein_g,1)}جم</div></div>
        <button class="ghost" onclick='applySwap("${slotKey}",${JSON.stringify(JSON.stringify(s))})'>استبدل</button>
      </div>`).join(''));
}
async function applySwap(slotKey, json){
  const s = JSON.parse(json);
  const full = await api(`/foods/${s.canonical_id}`);
  plan[slotKey] = {canonical_id:s.canonical_id, name_ar:s.name_ar, food_role:s.food_role,
    kcal:full.serving.kcal, protein_g:full.serving.protein_g, carb_g:full.serving.carb_g,
    fat_g:full.serving.fat_g, fiber_g:full.serving.fiber_g,
    evidence_tier:(full.evidence&&full.evidence.tier)||'unknown', category:full.category};
  closeModal(); renderPlan();
}
function clearSlot(k){ plan[k]=null; renderPlan(); }

/* ---------- plan render ---------- */
function renderPlan(){
  const rows = SLOTS.map(s=>{
    const it = plan[s.key];
    if(!it) return `<tr><td colspan="6" style="color:var(--ink-3)">
        <b>${s.key}</b> — <a style="color:var(--teal-mid);cursor:pointer" onclick="pickSlot('${s.key}')">اختر صنف</a></td></tr>`;
    return `<tr>
      <td><b>${it.name_ar}</b><div class="hint">${s.key}</div></td>
      <td><span class="role">${it.food_role}</span></td>
      <td>${fmt(it.kcal)}</td>
      <td>${it.protein_g===null?'<span class="hint">غير معروف</span>':fmt(it.protein_g,1)+'جم'}</td>
      <td><span class="tier ${it.evidence_tier}">${it.evidence_tier}</span></td>
      <td style="white-space:nowrap">
        <button class="ghost" onclick="swap('${s.key}')">بديل</button>
        <button class="ghost" onclick="clearSlot('${s.key}')">حذف</button></td>
    </tr>`;
  }).join('');
  planRows.innerHTML = rows;

  const items = Object.values(plan).filter(Boolean);
  if(!targets || !items.length){ totals.innerHTML=''; planNote.textContent=''; return; }

  // Unknown macros stay unknown. Totals show a floor, never a fabricated zero.
  const sum = k => items.reduce((a,i)=> a + (num(i[k])||0), 0);
  const missing = k => items.filter(i=> num(i[k])===null).length;
  const kc=sum('kcal'), pr=sum('protein_g');
  const mk=missing('kcal'), mp=missing('protein_g');
  const pctK = Math.round(kc/targets.kcal*100);

  totals.innerHTML = `
    <div class="tot ${pctK>110?'warn':''}"><div class="v">${mk?'≥':''}${Math.round(kc)}</div><div class="l">سعرات / ${targets.kcal}</div></div>
    <div class="tot"><div class="v">${pctK}%</div><div class="l">من الهدف</div></div>
    <div class="tot ${pr<targets.protein*0.8?'warn':''}"><div class="v">${mp?'≥':''}${Math.round(pr)}</div><div class="l">بروتين / ${targets.protein}جم</div></div>
    <div class="tot"><div class="v">${items.length}/5</div><div class="l">وجبات مختارة</div></div>`;

  const notes=[];
  if(mp) notes.push(`${mp} صنف من غير بيانات بروتين — الرقم المعروض حد أدنى وليس القيمة الحقيقية.`);
  if(pr < targets.protein*0.8 && items.length===5) notes.push('البروتين أقل من 80% من الهدف. جرب بديل أعلى بروتين في الغداء أو العشاء.');
  if(kc > targets.kcal*1.1) notes.push('إجمالي السعرات تجاوز الهدف بأكثر من 10%.');
  planNote.innerHTML = notes.join('<br>');
}

/* ---------- search ---------- */
async function runSearch(){
  searchRows.innerHTML = '<tr><td colspan="7" class="empty">جارٍ البحث…</td></tr>';
  const p = new URLSearchParams({q:sq.value, limit:40});
  if(srole.value) p.set('role', srole.value);
  if(scat.value)  p.set('category', scat.value);
  try{
    const d = await api('/foods?'+p);
    if(!d.items.length){ searchRows.innerHTML='<tr><td colspan="7" class="empty">لا توجد نتائج مطابقة.</td></tr>'; return; }
    searchRows.innerHTML = d.items.map(i=>`<tr>
      <td><b>${esc(i.name_ar)}</b>${i.name_en?`<div class="hint">${esc(i.name_en)}</div>`:''}</td>
      <td><span class="role">${esc(i.food_role)}</span></td>
      <td>${fmt(i.kcal)}</td>
      <td>${i.protein_g===null?'<span class="hint">—</span>':fmt(i.protein_g,1)}</td>
      <td class="hint">${esc(i.portion_label||'')}</td>
      <td><span class="tier ${esc(i.evidence_tier)}">${esc(i.evidence_tier)}</span>
          ${i.status==='CORRECTED_PENDING_SIGNOFF'?'<span class="pending">مُصحح</span>':''}</td>
      <td><button class="ghost" onclick="showSubs(decodeURIComponent('${enc(i.canonical_id)}'),decodeURIComponent('${enc(i.name_ar||'')}'))">بدائل</button></td>
    </tr>`).join('');
  }catch(e){ searchRows.innerHTML='<tr><td colspan="7" class="empty">تعذر الاتصال بالخادم.</td></tr>'; }
}
async function showSubs(id,name){
  showModal(`<h3>بدائل ${name}</h3><div class="empty">جارٍ البحث…</div>`);
  const d = await api(`/foods/${id}/substitutes?limit=12`);
  showModal(`<h3>بدائل ${name}</h3>` + (d.substitutes.length
    ? d.substitutes.map(s=>`<div class="srow"><div><b>${s.name_ar}</b>
        <span class="tier ${s.evidence_tier}">${s.evidence_tier}</span>
        <div class="diff">${fmt(s.kcal)} سعرة · بروتين ${fmt(s.protein_g,1)}جم</div></div></div>`).join('')
    : '<div class="empty">لا يوجد بديل بنفس الدور الغذائي في النطاق المسموح.</div>'));
}

/* ---------- review ---------- */
let reviewReason = 'ALLERGEN_PROFILE_REVIEW';
let currentPageIds = [];
async function loadReview(){
  reviewRows.innerHTML='<tr><td colspan="5" class="empty">جارٍ التحميل…</td></tr>';
  allergenBanner.style.display = reviewReason==='ALLERGEN_PROFILE_REVIEW' ? 'block' : 'none';
  try{
    const d = await api('/review-queue');
    const items = d.items.filter(i=>i.reason===reviewReason);
    if(!items.length){ reviewRows.innerHTML='<tr><td colspan="5" class="empty">لا يوجد أصناف في هذه القائمة.</td></tr>'; currentPageIds=[]; return; }
    const page = items.slice(0,60);
    currentPageIds = page.map(i=>i.id);
    if(reviewReason==='ALLERGEN_PROFILE_REVIEW'){
      reviewRows.innerHTML = page.map(i=>`<tr>
        <td><b>${i.name_ar}</b>${i.name_en?`<div class="hint">${i.name_en}</div>`:''}<div class="hint">${i.canonical_id}${i.brand?' · '+i.brand:''}</div></td>
        <td colspan="2">${(i.allergen_tags||[]).map(t=>{
          const [a,c]=t.split(':');
          return `<span class="tier ${c==='name_keyword'?'verified':'calculated'}">${a}</span>`;
        }).join(' ')}</td>
        <td class="hint">${(i.allergen_tags||[]).some(t=>t.endsWith(':inferred_pattern'))?'مُستنتج من نوع الطبق، مش من الاسم مباشرة':'مذكور في الاسم مباشرة'}</td>
        <td><button class="ghost" onclick="approve(${i.id})">تأكيد</button></td>
      </tr>`).join('');
    } else {
      reviewRows.innerHTML = page.map(i=>`<tr>
        <td><b>${i.name_ar}</b><div class="hint">${i.canonical_id}${i.brand?' · '+i.brand:''}</div></td>
        <td>${fmt(i.kcal)}</td>
        <td>${fmt(i.kcal_from_macros)}</td>
        <td class="hint">${i.detail||''}</td>
        <td><button class="ghost" onclick="approve(${i.id})">اعتمد</button></td>
      </tr>`).join('');
    }
  }catch(e){ reviewRows.innerHTML='<tr><td colspan="5" class="empty">تعذر الاتصال بالخادم.</td></tr>'; }
}
async function approve(id){
  if(!confirm('الاعتماد هيتسجل باسم حسابك في سجل التدقيق. تأكيد؟')) return;
  try{
    const res = await api(`/review-queue/${id}/resolve`,{method:'POST',
      body: JSON.stringify({decision:'APPROVED'})});
    alert('تم الاعتماد وتسجيله باسم: ' + res.resolved_by);
    loadReview();
  }catch(e){ alert('لم يتم الاعتماد: ' + e.message); }
}
async function bulkVerifyVisible(){
  if(!currentPageIds.length) return;
  if(!confirm(`تأكيد ${currentPageIds.length} صنف دفعة واحدة باسم حسابك؟`)) return;
  try{
    const res = await api('/review-queue/bulk-verify-allergens',{method:'POST',
      body: JSON.stringify({ids:currentPageIds})});
    alert(`تم تأكيد ${res.verified} صنف.`);
    loadReview();
  }catch(e){ alert('تعذر التأكيد الجماعي: '+e.message); }
}

/* ---------- chrome ---------- */
function showModal(html){ modalBox.innerHTML = html +
  '<div style="text-align:left;margin-top:14px"><button class="ghost" onclick="closeModal()">إغلاق</button></div>';
  modal.classList.add('on'); }
function closeModal(){ modal.classList.remove('on'); }
modal.onclick = e => { if(e.target===modal) closeModal(); };
document.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });

document.querySelectorAll('nav button').forEach(b=>{
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    ['dashboard','workspace','search','review'].forEach(v=>
      document.getElementById('view-'+v).style.display = (v===b.dataset.view?'':'none'));
    if(b.dataset.view==='review') loadReview();
    if(b.dataset.view==='dashboard') loadDashboard();
  };
});
document.querySelectorAll('.tabs-sub a').forEach(a=>{
  a.onclick = () => {
    document.querySelectorAll('.tabs-sub a').forEach(x=>x.classList.remove('on'));
    a.classList.add('on'); reviewReason = a.dataset.reason; loadReview();
  };
});

/* ---------- dashboard ---------- */
let allClients = [];
async function loadDashboard(){
  try{
    const [dash, clients] = await Promise.all([api('/dashboard'), api('/clients')]);
    allClients = clients.items;
    dsClients.textContent = dash.total_clients;
    let draft=0, approved=0;
    Object.values(dash.plans_by_client).forEach(s=>{ draft+=s.DRAFT||0; approved+=s.APPROVED||0; });
    dsDraft.textContent = draft; dsApproved.textContent = approved;

    dashOverdue.innerHTML = dash.followup_due_or_overdue.length
      ? dash.followup_due_or_overdue.map(o=>`<tr>
          <td><b>${esc(o.full_name)}</b></td>
          <td>${o.last_visit ? fmtDate(o.last_visit) : 'لا يوجد'}</td>
          <td>${o.days_since===null?'<span class="pending">مفيش متابعة خالص</span>':o.days_since+' يوم'}</td>
          <td><button class="ghost" onclick="openWorkspace(${o.client_id})">فتح</button></td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">مفيش عميلات محتاجة متابعة دلوقتي 👍</td></tr>';

    dashClients.innerHTML = allClients.length
      ? allClients.map(c=>{
          const p = dash.plans_by_client[c.id]||{};
          return `<tr><td><b>${esc(c.full_name)}</b></td><td class="hint">${esc(c.goal||'—')}</td>
            <td class="hint">${p.DRAFT?p.DRAFT+' مسودة ':''}${p.APPROVED?p.APPROVED+' معتمدة':''}${!p.DRAFT&&!p.APPROVED?'—':''}</td>
            <td><button class="ghost" onclick="openWorkspace(${c.id})">فتح</button></td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="empty">لسه مفيش عميلات. اضغطي "+ عميلة جديدة".</td></tr>';
  }catch(e){ dashOverdue.innerHTML = dashClients.innerHTML = '<tr><td colspan="4" class="empty">تعذر الاتصال بالخادم.</td></tr>'; }
}
function fmtDate(s){ return new Date(s).toLocaleDateString('ar-EG',{day:'numeric',month:'short',year:'numeric'}); }

async function openNewClient(){
  const name = prompt('اسم العميلة:'); if(!name) return;
  try{
    const c = await api('/clients',{method:'POST', body:JSON.stringify({full_name:name})});
    await loadDashboard();
    openWorkspace(c.id);
  }catch(e){ alert('تعذر الإضافة: '+e.message); }
}

/* ---------- client workspace ---------- */
let wsClientId = null;
async function openWorkspace(id){
  wsClientId = id;
  document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
  document.querySelector('nav button[data-view="workspace"]').classList.add('on');
  ['dashboard','workspace','search','review'].forEach(v=>
    document.getElementById('view-'+v).style.display = (v==='workspace'?'':'none'));
  await refreshWorkspace();
}
async function refreshWorkspace(){
  if(!wsClientId) return;
  try{
    const client = await api(`/clients/${wsClientId}`);
    wsName.textContent = client.full_name;
    wsSub.textContent = [client.gender, client.birth_year?`مواليد ${client.birth_year}`:'', client.goal].filter(Boolean).join(' · ');

    const [cons, fi, dw, plans] = await Promise.all([
      api(`/clients/${wsClientId}/constraints`),
      api(`/clients/${wsClientId}/followup-intelligence`),
      api(`/clients/${wsClientId}/decision-workspace`),
      api(`/clients/${wsClientId}/plans`)
    ]);

    wsConstraints.innerHTML = cons.items.length
      ? cons.items.map(c=>`<div class="srow"><div><span class="role">${esc(c.kind)}</span> ${esc(c.value)} <span class="hint">(${esc(c.severity)})</span></div>
          <button class="ghost" onclick="removeConstraint(${c.id})">حذف</button></div>`).join('')
      : '<div class="empty">مفيش قيود مسجلة</div>';

    wsFollowup.innerHTML = fi.status==='NO_DATA' ? '<div class="empty">لا توجد بيانات متابعة بعد</div>' :
      `<p><b>${fi.status}</b> · ${fi.followups} متابعة</p>
       ${fi.alerts.length ? fi.alerts.map(a=>`<div class="note" style="color:${a.severity==='HIGH'?'var(--flag)':'var(--amber)'}">⚠ ${a.message}</div>`).join('') : '<p class="note">مفيش تنبيهات آلية حاليًا.</p>'}
       <p class="hint" style="margin-top:8px">${esc(fi.summary)}</p>`;

    wsDecision.innerHTML = dw.actions.length
      ? dw.actions.map(a=>`<div class="srow"><div><span class="tier ${a.priority==='HIGH'?'estimated':'verified'}">${a.priority}</span> ${esc(a.action)}</div></div>`).join('')
      : `<p class="note">${dw.summary}</p>`;

    wsPlans.innerHTML = plans.items.length
      ? plans.items.map(p=>`<tr><td>v${p.version}</td>
          <td><span class="role">${p.workflow_status}</span></td>
          <td>${p.quality_score ?? '—'}</td>
          <td>${p.workflow_status==='DRAFT' ? `<button class="ghost" onclick="submitPlan(${p.id})">أرسل للمراجعة</button>` : ''}
              ${p.workflow_status==='IN_REVIEW' ? `<button class="ghost" onclick="approvePlan(${p.id})">اعتماد</button>` : ''}
              ${p.workflow_status==='APPROVED' && !p.is_released ? `<button class="ghost" onclick="releasePlan(${p.id})">إصدار</button>` : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">لسه مفيش خطط لهذه العميلة</td></tr>';
  }catch(e){ wsName.textContent = 'تعذر تحميل بيانات العميلة'; }
}

async function addConstraint(){
  if(!wsClientId) return;
  const value = wsConValue.value.trim(); if(!value) return;
  try{
    await api(`/clients/${wsClientId}/constraints`,{method:'POST', body:JSON.stringify({
      kind:wsConKind.value, constraint_key:wsConKind.value, value, severity:'HARD'})});
    wsConValue.value=''; refreshWorkspace();
  }catch(e){ alert('تعذر الإضافة: '+e.message); }
}
async function removeConstraint(id){
  if(!confirm('حذف القيد؟')) return;
  await api(`/clients/${wsClientId}/constraints/${id}`,{method:'DELETE'});
  refreshWorkspace();
}
async function submitPlan(id){
  try{ await api(`/plans/${id}/submit`,{method:'POST'}); refreshWorkspace(); }
  catch(e){ alert('تعذر الإرسال: '+e.message); }
}
async function approvePlan(id){
  if(!confirm('اعتماد الخطة؟ الاعتماد سيسمح لاحقًا بإصدارها للعميلة بعد اجتياز الجودة.')) return;
  try{ await api(`/plans/${id}/approve`,{method:'POST'}); refreshWorkspace(); }
  catch(e){ alert('تعذر الاعتماد: '+e.message); }
}
async function releasePlan(id){
  if(!confirm('إصدار الخطة هيوصلها للعميلة ويستبدل أي خطة قديمة معتمدة. تأكيد؟')) return;
  try{ const r = await api(`/plans/${id}/release`,{method:'POST'}); alert('تم الإصدار باسم: '+r.approved_by); refreshWorkspace(); }
  catch(e){ alert('تعذر الإصدار: '+e.message); }
}

/* ---------- AI copilot ---------- */
let wsAiIntent = null;
async function runAiCopilot(){
  const task = wsAiTask.value.trim(); if(!task) return;
  wsAiParsed.style.display='block'; wsAiParsed.textContent='جارٍ الفهم…';
  wsAiGenerate.style.display='none'; wsAiNote.textContent='';
  try{
    const r = await api('/ai/planning-copilot',{method:'POST', body:JSON.stringify({task})});
    wsAiIntent = r;
    const i = r.intent;
    wsAiParsed.innerHTML = `<b>${esc(i.target_kcal??'؟')} سعرة</b> · بروتين ${esc(i.target_protein_g??'؟')}جم ·
      ${i.meals_per_day} وجبات · ${i.days} أيام
      ${i.excluded_allergens.length?'<br>ممنوع: '+i.excluded_allergens.join('، '):''}
      ${i.diet_tags.length?'<br>نظام: '+i.diet_tags.join('، '):''}`;
    if(r.ready){ wsAiGenerate.style.display='block'; }
    else { wsAiNote.textContent = 'الطلب ناقص: '+r.errors.join('، ')+' — لازم تحددي السعرات والبروتين على الأقل.'; }
  }catch(e){ wsAiParsed.textContent = 'تعذر فهم الطلب: '+e.message; }
}
async function generateAiDraft(){
  if(!wsClientId){ alert('اختاري عميلة أولاً'); return; }
  wsAiNote.textContent = 'جارٍ توليد المسودة…';
  try{
    const r = await api(`/clients/${wsClientId}/plans/from-ai`,{method:'POST', body:JSON.stringify({task:wsAiTask.value.trim()})});
    wsAiNote.innerHTML = r.quality.blockers.length
      ? `<b style="color:var(--flag)">الخطة اتحفظت كمسودة بس فيها ${r.quality.blockers.length} مشكلة</b> — راجعيها قبل الإرسال.`
      : `تم توليد مسودة (جودة ${r.quality.score}). راجعيها في جدول "خطط العميلة" تحت.`;
    wsAiGenerate.style.display='none';
    refreshWorkspace();
  }catch(e){ wsAiNote.textContent = 'تعذر التوليد: '+e.message; }
}

(function init(){
  const roles = ['','PROTEIN','STARCH','DAIRY','FRUIT','VEGETABLE','LEGUME','FAT_NUT','BEVERAGE','SWEET','BAR_SUPP','COMPOSITE_MEAL'];
  srole.innerHTML = roles.map(r=>`<option value="${r}">${r||'كل الأدوار'}</option>`).join('');
  const cats = ['','فطار','رئيسية','سناك','سلطة','مشروب','عشاء','سحور'];
  scat.innerHTML = cats.map(c=>`<option value="${c}">${c||'كل التصنيفات'}</option>`).join('');
  buildSlots(); checkSession();
  sq.addEventListener('keydown', e=>{ if(e.key==='Enter') runSearch(); });
  lgPass.addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });
  lgEmail.addEventListener('keydown', e=>{ if(e.key==='Enter') lgPass.focus(); });
})();
