const { chromium } = require('playwright');

const results = [];
const rec = (ok, name, detail='') => {
  results.push({ok, name, detail});
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n        ' + detail}`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const apiErrors = [];
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); try { await d.accept(); } catch {} });
  page.on('response', async r => {
    if (r.status() >= 400 && r.url().includes('/api/') && !r.url().includes('/auth/me')) {
      let b=''; try{b=await r.text();}catch{}
      apiErrors.push(`${r.status()} ${r.url().replace('http://localhost:3000','')} ${b.slice(0,150)}`);
    }
  });

  console.log('\n=== A. LOGIN & SHELL ===');
  await page.goto('http://localhost:3000/');
  rec(await page.locator('#gate').isVisible(), 'login gate shown when logged out');
  await page.fill('#lgEmail','owner@newtrition.local');
  await page.fill('#lgPass','Owner!2345');
  await page.click('#lgBtn');
  await page.waitForTimeout(1500);
  rec(!(await page.locator('#gate').isVisible()), 'gate dismissed after login');
  rec((await page.locator('#apiStatus').innerText()).includes('متصل'), 'API status shows connected',
      await page.locator('#apiStatus').innerText());

  console.log('\n=== B. CLIENT REGISTRATION (full intake) ===');
  await page.click('button:has-text("+ عميلة جديدة")');
  await page.waitForTimeout(400);
  rec(await page.locator('#ncWt').isVisible(), 'intake modal has weight field (not bare prompt)');
  await page.fill('#ncName','مريم أحمد');
  await page.fill('#ncAge','32');
  await page.fill('#ncHt','163');
  await page.fill('#ncWt','86');
  await page.selectOption('#ncAct','1.375');
  await page.selectOption('#ncGoal','-0.20');
  await page.click('button:has-text("حفظ واحسب الأهداف")');
  await page.waitForTimeout(1500);
  const view1 = await page.evaluate(()=>document.querySelector('nav button.on')?.dataset.view);
  rec(view1==='plan', 'lands on plan builder after registration (not constraints page)', `landed on ${view1}`);
  const calc1 = await page.locator('#calcOut').innerText();
  rec(/سعرة/.test(calc1) && /BMR/.test(calc1), 'targets computed immediately on registration', calc1.slice(0,120));

  console.log('\n=== C. CONTEXT PERSISTENCE (the V8.5.6 bug) ===');
  const before = await page.locator('#cClient').inputValue();
  await page.click('nav button[data-view="dashboard"]');
  await page.waitForTimeout(1200);
  const after = await page.locator('#cClient').inputValue();
  rec(before && after===before, 'client selection survives a dashboard visit', `before=${before} after=${after}`);
  await page.click('nav button[data-view="plan"]');
  await page.waitForTimeout(500);
  const dBefore = dialogs.length;
  await page.click('button:has-text("تحميل بيانات العميلة")');
  await page.waitForTimeout(800);
  rec(dialogs.length===dBefore, 'load-client works without "choose a client" alert',
      dialogs.slice(dBefore).join(' | '));
  rec((await page.locator('#cWt').inputValue())==='86.0', 'real weight restored (not the 80kg default)',
      await page.locator('#cWt').inputValue());

  console.log('\n=== D. BUILD A FULL DAY PLAN via slot picker ===');
  const slots = ['فطار','سناك ١','غداء','سناك ٢','عشاء'];
  for (const s of slots) {
    await page.click(`#slotBar button:has-text("${s}")`);
    await page.waitForTimeout(1200);
    const opts = await page.locator('#modalBox .srow button:has-text("اختر")').count();
    if (!opts) { rec(false, `slot ${s}: picker returned candidates`, 'zero candidates'); await page.click('button:has-text("إغلاق")'); continue; }
    await page.locator('#modalBox .srow button:has-text("اختر")').first().click();
    await page.waitForTimeout(500);
  }
  const rowCount = await page.locator('#planRows tr').count();
  rec(rowCount>=5, 'all five meal slots filled from the picker', `rows=${rowCount}`);
  const totalsTxt = await page.locator('#totals').innerText().catch(()=>'');
  rec(/سعرة|kcal|\d/.test(totalsTxt), 'plan totals rendered', totalsTxt.slice(0,120));

  console.log('\n=== E. MULTI-ITEM MEAL + SUBSTITUTES ===');
  await page.click(`#slotBar button:has-text("فطار")`);
  await page.waitForTimeout(1200);
  if (await page.locator('#modalBox .srow button:has-text("اختر")').count()) {
    await page.locator('#modalBox .srow button:has-text("اختر")').first().click();
    await page.waitForTimeout(500);
  }
  const breakfastRows = await page.locator('#planRows tr').count();
  rec(breakfastRows>rowCount, 'second item added to the same meal slot', `${rowCount} -> ${breakfastRows}`);
  const swapBtn = page.locator('#planRows button:has-text("بديل")').first();
  if (await swapBtn.count()) {
    await swapBtn.click();
    await page.waitForTimeout(1500);
    const mt = await page.locator('#modalBox').innerText();
    rec(!/تعذر|خطأ/.test(mt), 'substitutes modal opens without error', mt.slice(0,150));
    await page.click('button:has-text("إغلاق")');
  } else rec(false,'substitute button present','none found');

  console.log('\n=== F. SAVE DRAFT (via review step 3) ===');
  await page.click('button:has-text("التالي: المراجعة")');
  await page.waitForTimeout(600);
  rec(await page.locator('#planStep3').isVisible(), 'review step shows before save', 'step3 visible');
  const sBefore = dialogs.length;
  await page.click('button:has-text("حفظ الخطة كمسودة")');
  await page.waitForTimeout(2500);
  const saveMsg = dialogs.slice(sBefore).join(' | ');
  rec(/تم حفظ المسودة/.test(saveMsg), 'save draft succeeded', saveMsg || '(no dialog)');

  console.log('\n=== G. SEARCH CATALOG + ADD TO PLAN ===');
  await page.click('nav button[data-view="search"]');
  await page.waitForTimeout(600);
  await page.fill('#sq','فراخ');
  await page.click('button:has-text("ابحث")');
  await page.waitForTimeout(1800);
  const nres = await page.locator('#searchRows button:has-text("+ للخطة")').count();
  rec(nres>0, 'catalog search returns results with add buttons', `${nres} results`);
  const status = await page.locator('#sqStatus').innerText();
  rec(/جاهزة للإضافة|العميلة/.test(status), 'search page shows active client context', status.slice(0,120));
  if (nres) {
    await page.locator('#searchRows button:has-text("+ للخطة")').first().click();
    await page.waitForTimeout(1200);
    rec((await page.evaluate(()=>document.querySelector('nav button.on')?.dataset.view))==='plan',
        'add-from-search navigates to plan builder');
  }

  console.log('\n=== H. WORKSPACE + AI COPILOT ===');
  await page.click('nav button[data-view="workspace"]');
  await page.waitForTimeout(1200);
  const wsT = await page.locator('#wsTargetsBody').innerText();
  rec(/سعرة/.test(wsT), 'workspace shows computed targets card', wsT.slice(0,120));
  await page.click('button:has-text("افهم الطلب")');
  await page.waitForTimeout(400);
  rec(/اكتبي طلبك/.test(await page.locator('#wsAiParsed').innerText()),
      'AI gives clear guidance on empty input (not silent)');
  await page.fill('#wsAiTask','اعمل خطة 1600 كالوري و110 بروتين، 5 وجبات، 3 أيام، بدون لبن');
  await page.click('button:has-text("افهم الطلب")');
  await page.waitForTimeout(1800);
  const parsed = await page.locator('#wsAiParsed').innerText();
  rec(/1600/.test(parsed) && /110/.test(parsed), 'AI parses the Arabic request correctly', parsed.slice(0,150));

  console.log('\n=== I. CONSTRAINTS (allergy) ===');
  await page.fill('#wsConValue','milk');
  await page.click('button:has-text("+ إضافة قيد HARD")');
  await page.waitForTimeout(1500);
  rec(/milk/.test(await page.locator('#wsConstraints').innerText()), 'allergy constraint saved and listed');

  console.log('\n=== J. PLANS LIST + REVIEW TAB ===');
  const plansTxt = await page.locator('#wsPlans').innerText();
  rec(/\d/.test(plansTxt), 'saved plan appears in the client plans table', plansTxt.slice(0,150));
  await page.click('nav button[data-view="review"]');
  await page.waitForTimeout(1800);
  rec(await page.locator('#view-review').isVisible(), 'data-review tab renders');

  console.log('\n=== K. CLIENT STILL REGISTERED AFTER FULL SESSION ===');
  await page.click('nav button[data-view="dashboard"]');
  await page.waitForTimeout(1500);
  const dash = await page.locator('#dashClients').innerText();
  rec(/مريم أحمد/.test(dash), 'client persists on dashboard after the whole session', dash.slice(0,200));

  console.log('\n=== L. RESOURCES LIBRARY ===');
  for (const [url,needle] of [['/resources','مكتبة'],['/content/recipes.html','وصفات'],
                              ['/content/exercise.html','تمارين'],['/content/exchange.html','بدائل'],
                              ['/content/faq.html','الأسئلة']]) {
    const p2 = await browser.newPage();
    const resp = await p2.goto('http://localhost:3000'+url);
    const body = await p2.content();
    rec(resp.status()===200 && body.includes(needle), `${url} renders in browser`, `status ${resp.status()}`);
    await p2.close();
  }

  console.log('\n=== M. CLIENT PORTAL PAGE ===');
  const p3 = await browser.newPage();
  const r3 = await p3.goto('http://localhost:3000/client');
  rec(r3.status()===200, '/client portal loads');
  rec((await p3.content()).includes('مكتبة الموارد'), 'client portal links to resources library');
  await p3.close();

  console.log('\n\n================ BROWSER SUMMARY ================');
  const pass = results.filter(r=>r.ok).length, fail = results.length-pass;
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  if (fail) { console.log('\nFAILURES:'); results.filter(r=>!r.ok).forEach((f,i)=>console.log(`${i+1}. ${f.name}\n   ${f.detail}`)); }
  console.log('\n=== UNCAUGHT PAGE EXCEPTIONS ==='); pageErrors.forEach(e=>console.log(' -',e));
  console.log('=== API ERROR RESPONSES ==='); apiErrors.forEach(e=>console.log(' -',e));

  await browser.close();
  process.exit(fail?1:0);
})();
