'use strict';
/* Deep static audit of the front-end HTML files:
 *  - duplicate top-level function declarations (the class of bug that silently
 *    overrode openNewClient and approvePlan in earlier versions)
 *  - onclick/onchange handlers referencing functions that don't exist
 *  - element ids referenced in JS but absent from the DOM (the cClient class of bug)
 */
const fs = require('fs');

let problems = 0;
const flag = (file, msg) => { problems++; console.log(`  ISSUE  [${file}] ${msg}`); };

for (const file of ['index.html', 'client.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

  console.log(`\n--- ${file} ---`);

  // 1. duplicate function declarations
  const decls = [...scripts.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  const counts = {};
  decls.forEach(d => counts[d] = (counts[d] || 0) + 1);
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  if (dupes.length) dupes.forEach(([n, c]) => flag(file, `duplicate function "${n}" declared ${c}x — the last one silently wins`));
  else console.log('  ok  no duplicate function declarations');

  // 2. inline handlers referencing undefined functions
  const defined = new Set(decls);
  // also const/let/var assigned functions and arrow consts
  for (const m of scripts.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/gm)) defined.add(m[1]);
  const handlerFns = new Set();
  for (const m of html.matchAll(/on(?:click|change|input|submit)\s*=\s*["']([^"']+)["']/g)) {
    const call = m[1].match(/([A-Za-z_$][\w$]*)\s*\(/);
    if (call) handlerFns.add(call[1]);
  }
  const missingFns = [...handlerFns].filter(f => !defined.has(f) && !['alert','confirm'].includes(f));
  if (missingFns.length) missingFns.forEach(f => flag(file, `inline handler calls undefined function "${f}()"`));
  else console.log('  ok  all inline handlers resolve to defined functions');

  // 3. bare identifiers used as element ids (implicit window.<id>) that don't exist in DOM
  const domIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  // find identifiers used like `someId.value` / `someId.innerHTML` / `someId.textContent`
  const used = new Set();
  for (const m of scripts.matchAll(/\b([a-z][A-Za-z0-9_$]*)\.(value|innerHTML|textContent|innerText|style|classList|checked|focus|disabled)\b/g)) {
    used.add(m[1]);
  }
  const jsLocals = new Set([...scripts.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  for (const m of scripts.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) jsLocals.add(m[1]);
  for (const m of scripts.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
    m[1].split(',').map(s => s.trim().split(/[=\s]/)[0]).filter(Boolean).forEach(p => jsLocals.add(p));
  }
  for (const m of scripts.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) jsLocals.add(m[1]);
  for (const m of scripts.matchAll(/for\s*\(\s*(?:const|let|var)\s+(?:\[)?([A-Za-z_$][\w$,\s]*)/g)) {
    m[1].split(',').map(s=>s.trim()).filter(Boolean).forEach(p=>jsLocals.add(p));
  }
  const globals = new Set(['document','window','location','navigator','console','JSON','Math','Number','String',
    'Object','Array','Date','Promise','fetch','localStorage','sessionStorage','this','event','e','r','d','c','p','s','i','m','x','o','u','f','t','v','b','a','n','res','req','err','msg','opts','item','row','plan','targets','modal','gate','who']);
  const suspicious = [...used].filter(id => !domIds.has(id) && !jsLocals.has(id) && !globals.has(id));
  if (suspicious.length) suspicious.forEach(id => flag(file, `JS uses "${id}.<prop>" but no element with id="${id}" exists and it is not a local variable`));
  else console.log('  ok  no references to non-existent element ids');

  // 4. id/variable collisions: an element with id="x" creates an implicit
  //    window.x, but an explicit `const x = ...` in the same scope wins,
  //    silently breaking any code that expects `x` to be the DOM element
  //    (e.g. `x.onclick = x` assigns a handler to the function, not the
  //    button). This exact bug made the client portal's login button inert.
  //    Safe and excluded: `const x = document.getElementById('x')` (or
  //    querySelector('#x')) explicitly re-fetches the same element, which is
  //    equivalent to the implicit global, not a shadowing bug.
  const collisions = [...domIds].filter(id => {
    if (!defined.has(id) && !jsLocals.has(id)) return false;
    const safePattern = new RegExp(
      `(?:const|let|var)\\s+${id}\\s*=\\s*document\\.(?:getElementById\\(['"]${id}['"]\\)|querySelector\\(['"]#${id}['"]\\))`);
    return !safePattern.test(scripts);
  });
  if (collisions.length) collisions.forEach(id =>
    flag(file, `id="${id}" collides with a local const/let/var/function "${id}" — "${id}.onclick=..." would target the JS value, not the element`));
  else console.log('  ok  no id/local-variable name collisions');
}

console.log(`\n${problems === 0 ? 'STATIC AUDIT: PASS' : `STATIC AUDIT: ${problems} issue(s) found`}`);
process.exit(problems ? 1 : 0);
