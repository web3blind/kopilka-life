const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const css=readFileSync(process.env.KOPILKA_CSS_UNDER_TEST || join(__dirname,'../public/styles.css'),'utf8');

test('Android inherits transparent tap highlight without removing keyboard focus styling',()=>{
 const html=css.match(/(?:^|\n)html\s*\{([^}]+)\}/)?.[1];
 assert.ok(html,'root CSS rule exists');
 assert.match(html,/-webkit-tap-highlight-color\s*:\s*transparent/);
 assert.match(css,/:focus-visible\s*\{/,'keyboard focus feedback is retained');
});

test('Secondary and tab presses survive later base shadows without affecting disabled controls',()=>{
 for(const selector of ['button.secondary','.tab-bar button']){
  const active=selector+':active:not([disabled]):not([aria-disabled="true"])';
  const start=css.indexOf(active+'{');
  assert.ok(start>=0,active+' has an enabled-only pressed rule');
  const body=css.slice(start+active.length+1,css.indexOf('}',start));
  assert.match(body,/^box-shadow:/,'feedback is confined to the control shadow');
  assert.doesNotMatch(body,/background|border|outline|transform|padding|margin/,'no layout, selected colors or focus changes');
  const base=selector==='button.secondary'?'button.secondary{':'.tab-bar button[aria-selected="true"]{';
  assert.ok(start>css.indexOf(base),'pressed rule follows the overriding base state');
 }
});

test('Life circle stays in the heading rather than the explanatory paragraph',()=>{
 const circle=css.match(/\.balance-summary::before\s*\{([^}]+)\}/)?.[1];
 assert.ok(circle,'decorative circle rule exists');
 const value=(key)=>Number(circle.match(new RegExp('(?:^|;)\\s*'+key+'\\s*:\\s*([\\d.]+)rem'))?.[1]);
 assert.equal(value('width'),3.5);
 assert.equal(value('height'),3.5);
 assert.equal(value('top'),.65);
});
