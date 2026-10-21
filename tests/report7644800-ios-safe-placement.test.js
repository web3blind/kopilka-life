const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.REPORT7644800_APP || path.join(__dirname, '../public/app.js'), 'utf8');
const apply = source.slice(source.indexOf('function applyVkStatusTop()'), source.indexOf('\nfunction fireVkBridgeInit()'));
function run(platform, ua = 'iPhone OS 18_0', signed = true, previous = '', hash = false) {
  const query = `vk_platform=${platform}${signed ? '&vk_app_id=54723764&sign=fixture' : ''}`;
  const values = new Map(previous ? [['--vk-status-top',previous]] : []);
  const context = { URLSearchParams, navigator:{userAgent:ua}, document:{documentElement:{style:{setProperty:(k,v)=>values.set(k,v)}}},
    window:{location:{search:hash?'':'?'+query},getComputedStyle:()=>({getPropertyValue:k=>values.get(k)||''})},
    vkLaunchParams:()=>signed?(hash?'#':'?')+query:'' };
  vm.createContext(context); vm.runInContext(apply+';applyVkStatusTop();applyVkStatusTop();',context);
  return values.get('--vk-status-top') || '';
}
test('report7644800: signed native iPhone and Safari VK mobile_web reserve safe area PLUS toolbar',()=>{
  for (const platform of ['mobile_iphone','mobile_web']) for (const hash of [false,true]) {
    const value=run(platform,undefined,true,'',hash);
    assert.match(value,/calc\(env\(safe-area-inset-top, 0px\) \+ 64px\)/);
    assert.match(value,/max\(96px,/,'zero-inset iframe fallback clears the reported 90.5px toolbar bottom');
  }
});
test('report7644800: standalone iOS, unsigned platform hint, desktop VK, Android mobile_web unchanged',()=>{
  for (const platform of ['','desktop_web']) assert.equal(run(platform),'');
  for (const platform of ['mobile_iphone','mobile_web']) assert.equal(run(platform,undefined,false),'');
  assert.equal(run('mobile_web','Android 14'),'');
});
test('report7644800: Android keeps exactly the existing 64px floor and larger reservations',()=>{
  assert.equal(run('mobile_android','Android 14'),'64px');
  assert.equal(run('mobile_android','Android 14',true,'120px'),'120px');
});
