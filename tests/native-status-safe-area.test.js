const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'../public/styles.css'),'utf8');
test('status and cached status shells respect native VK toolbar inset',()=>{
 for(const selector of ['.status-notice:has(#statusRegion:not(:empty))','#appShell > #statusRegion:not(:empty)']){
  const start=css.indexOf(selector+'{');assert.ok(start>=0);
  const rule=css.slice(start,css.indexOf('}',start));
  assert.match(rule,/top:max\(calc\(env\(safe-area-inset-top\) \+ \.5rem\),var\(--vk-status-top,0px\)\)/);
 }
 assert.match(css,/#dismissStatus\{[^}]*pointer-events:auto/);
});
