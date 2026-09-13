const { chromium } = require('playwright');
const results=[]; const rec=(ok,n,d='')=>{results.push({ok,n,d});console.log(`  ${ok?'PASS':'FAIL'}  ${n}${ok?'':'\n        '+d}`);};
(async()=>{
  const browser=await chromium.launch();
  const page=await browser.newPage();
  const dialogs=[]; page.on('dialog',async d=>{dialogs.push(d.message());try{await d.accept();}catch{}});
  const apiErr=[]; page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/')&&!r.url().includes('/auth/me')&&!r.url().includes('/client-auth/me')){let b='';try{b=await r.text();}catch{};apiErr.push(`${r.status()} ${r.url().replace('http://localhost:3000','')} ${b.slice(0,120)}`);}});

  console.log('\n=== CLINICIAN: build + release a plan ===');
  await page.goto('http://localhost:3000/');
  await page.fill('#lgEmail','owner@newtrition.local'); await page.fill('#lgPass','Owner!2345');
  await page.click('#lgBtn'); await page.waitForTimeout(1200);
  await page.click('button:has-text("+ عميلة جديدة")'); await page.waitForTimeout(400);
  await page.fill('#ncName','نور رحلة كاملة'); await page.fill('#ncAge','29');
  await page.fill('#ncHt','162'); await page.fill('#ncWt','75');
  await page.click('button:has-text("حفظ واحسب الأهداف")'); await page.waitForTimeout(1500);
  for(const s of ['فطار','سناك ١','غداء','سناك ٢','عشاء']){
    await page.click(`#slotBar button:has-text("${s}")`); await page.waitForTimeout(1000);
    if(await page.locator('#modalBox .srow button:has-text("اختر")').count()){
      await page.locator('#modalBox .srow button:has-text("اختر")').first().click(); await page.waitForTimeout(350);
    } else await page.click('button:has-text("إغلاق")');
  }
  let d0=dialogs.length;
  await page.click('button:has-text("حفظ الخطة كمسودة")'); await page.waitForTimeout(2200);
  rec(/تم حفظ المسودة/.test(dialogs.slice(d0).join('|')),'plan saved');

  await page.click('nav button[data-view="workspace"]'); await page.waitForTimeout(1500);
  await page.locator('#wsPlans button:has-text("أرسل للمراجعة")').first().click(); await page.waitForTimeout(1800);
  await page.locator('#wsPlans button:has-text("اعتماد")').first().click(); await page.waitForTimeout(1800);
  await page.locator('#wsPlans button:has-text("إصدار")').first().click(); await page.waitForTimeout(1800);
  rec(/تم الإصدار/.test(dialogs.join('|')),'plan released to client');

  console.log('\n=== CLINICIAN: create the client portal account (new UI) ===');
  rec(await page.locator('#wsAccEmail').count()>0,'portal-account UI exists in workspace');
  await page.fill('#wsAccEmail','noor.journey@example.com');
  await page.click('button:has-text("إنشاء حساب ومنح كلمة مرور مؤقتة")');
  await page.waitForTimeout(2000);
  const accOut = await page.locator('#wsAccOut').innerText();
  rec(/تم إنشاء الحساب/.test(accOut),'account created and temp password shown', accOut.slice(0,200));
  const m = accOut.match(/كلمة المرور المؤقتة:\s*(\S+)/);
  const tempPass = m ? m[1] : null;
  console.log('        [debug] raw accOut:', JSON.stringify(accOut));
  console.log('        [debug] captured pass:', JSON.stringify(tempPass));
  rec(!!tempPass,'temporary password captured', accOut.slice(0,200));

  console.log('\n=== CLIENT: log into the portal and see her plan ===');
  const cp = await browser.newPage();
  cp.on('console', m => console.log('        [client console]', m.type(), m.text()));
  const planCalls = [];
  cp.on('response', async r => { if (r.url().includes('/api/client/plan')) { let b=''; try{b=await r.text();}catch{}; planCalls.push(`${Date.now()} status=${r.status()} body=${b.slice(0,150)}`); } });
  cp.on('pageerror', e => console.log('        [client pageerror]', String(e)));
  const cpErr=[]; cp.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/')&&!r.url().includes('/me')){let b='';try{b=await r.text();}catch{};cpErr.push(`${r.status()} ${r.url().replace('http://localhost:3000','')} ${b.slice(0,120)}`);}});
  await cp.goto('http://localhost:3000/client');
  await cp.fill('#email','noor.journey@example.com');
  await cp.fill('#password', tempPass||'x');
  await cp.click('#login');
  await cp.waitForTimeout(3500);
  console.log('        [debug] plan div raw HTML:', await cp.locator('#plan').innerHTML());
  console.log('        [debug] cookies:', JSON.stringify(await cp.context().cookies()));
  const directCall = await cp.evaluate(async () => {
    const r = await fetch('/api/client/plan', {credentials:'same-origin', headers:{'X-Requested-With':'newtrition-client'}});
    return {status: r.status, body: await r.text()};
  });
  console.log('        [debug] direct fetch from page:', JSON.stringify(directCall).slice(0,300));
  console.log('        [debug] ALL /api/client/plan calls in order:', JSON.stringify(planCalls));
  console.log('        [debug] err text:', await cp.locator('#err').innerText().catch(()=>''));
  console.log('        [debug] app class:', await cp.locator('#app').getAttribute('class'));
  const appVisible = !(await cp.locator('#app').getAttribute('class') || '').includes('hidden');
  rec(appVisible,'client logged into the portal', 'gate still shown');
  const planTxt = await cp.locator('#plan').innerText().catch(()=>'');
  rec(planTxt.length>10 && !/لا توجد خطة/.test(planTxt),'client sees her released plan', planTxt.slice(0,200));
  rec((await cp.content()).includes('مكتبة الموارد'),'client portal shows resources library link');

  console.log('\n================ CLIENT JOURNEY SUMMARY ================');
  const p=results.filter(r=>r.ok).length;
  console.log(`PASS: ${p}   FAIL: ${results.length-p}`);
  console.log('=== clinician API errors ==='); apiErr.forEach(e=>console.log(' -',e));
  console.log('=== client portal API errors ==='); cpErr.forEach(e=>console.log(' -',e));
  await browser.close();
})();
