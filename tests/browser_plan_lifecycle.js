const { chromium } = require('playwright');
const results=[]; const rec=(ok,n,d='')=>{results.push({ok,n,d});console.log(`  ${ok?'PASS':'FAIL'}  ${n}${ok?'':'\n        '+d}`);};
(async()=>{
  const browser=await chromium.launch(); const page=await browser.newPage();
  const dialogs=[]; page.on('dialog',async d=>{dialogs.push(d.message());try{await d.accept();}catch{}});
  const apiErr=[]; page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/')&&!r.url().includes('/auth/me')){let b='';try{b=await r.text();}catch{};apiErr.push(`${r.status()} ${r.url().replace('http://localhost:3000','')} ${b.slice(0,150)}`);}});
  page.on('pageerror',e=>console.log('[PAGE ERROR]',String(e)));

  await page.goto('http://localhost:3000/');
  await page.fill('#lgEmail','owner@newtrition.local'); await page.fill('#lgPass','Owner!2345');
  await page.click('#lgBtn'); await page.waitForTimeout(1200);

  await page.click('button:has-text("+ عميلة جديدة")'); await page.waitForTimeout(400);
  await page.fill('#ncName','سارة لايف سيكل'); await page.fill('#ncAge','30');
  await page.fill('#ncHt','165'); await page.fill('#ncWt','80');
  await page.click('button:has-text("حفظ واحسب الأهداف")'); await page.waitForTimeout(1500);

  console.log('\n=== build a complete 5-slot day ===');
  for(const s of ['فطار','سناك ١','غداء','سناك ٢','عشاء']){
    await page.click(`#slotBar button:has-text("${s}")`); await page.waitForTimeout(1100);
    const n=await page.locator('#modalBox .srow button:has-text("اختر")').count();
    if(n){ await page.locator('#modalBox .srow button:has-text("اختر")').first().click(); await page.waitForTimeout(400); }
    else { await page.click('button:has-text("إغلاق")'); }
  }
  await page.click('button:has-text("التالي: المراجعة")'); await page.waitForTimeout(500);
  const sBefore=dialogs.length;
  await page.click('button:has-text("حفظ الخطة كمسودة")'); await page.waitForTimeout(2500);
  rec(/تم حفظ المسودة/.test(dialogs.slice(sBefore).join('|')),'plan saved as DRAFT',dialogs.slice(sBefore).join('|'));

  console.log('\n=== lifecycle: DRAFT -> IN_REVIEW -> APPROVED -> RELEASED ===');
  await page.click('nav button[data-view="workspace"]'); await page.waitForTimeout(1500);

  let d0=dialogs.length;
  const submitBtn=page.locator('#wsPlans button:has-text("أرسل للمراجعة")').first();
  rec(await submitBtn.count()>0,'DRAFT plan shows "أرسل للمراجعة" button');
  if(await submitBtn.count()){ await submitBtn.click(); await page.waitForTimeout(2000); }
  console.log('        submit dialogs:',dialogs.slice(d0).join(' | ')||'(none)');

  d0=dialogs.length;
  const approveBtn=page.locator('#wsPlans button:has-text("اعتماد")').first();
  rec(await approveBtn.count()>0,'plan moved to IN_REVIEW (approve button appeared)',
      'still shows: '+(await page.locator('#wsPlans').innerText()).slice(0,200));
  if(await approveBtn.count()){ await approveBtn.click(); await page.waitForTimeout(2000); }
  console.log('        approve dialogs:',dialogs.slice(d0).join(' | ')||'(none)');

  d0=dialogs.length;
  const releaseBtn=page.locator('#wsPlans button:has-text("إصدار")').first();
  rec(await releaseBtn.count()>0,'plan APPROVED (release button appeared)',
      'plans table: '+(await page.locator('#wsPlans').innerText()).slice(0,200));
  if(await releaseBtn.count()){ await releaseBtn.click(); await page.waitForTimeout(2000); }
  const relMsg=dialogs.slice(d0).join(' | ');
  rec(/تم الإصدار/.test(relMsg),'plan RELEASED to client',relMsg||'(none)');

  console.log('\n=== client portal receives the released plan ===');
  console.log('        final plans table:', (await page.locator('#wsPlans').innerText()).slice(0,250));

  console.log('\n================ LIFECYCLE SUMMARY ================');
  const p=results.filter(r=>r.ok).length;
  console.log(`PASS: ${p}   FAIL: ${results.length-p}`);
  console.log('=== API ERRORS ==='); apiErr.forEach(e=>console.log(' -',e));
  await browser.close();
})();
