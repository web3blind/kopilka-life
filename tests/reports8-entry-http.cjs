'use strict';
// Run against the independently started private server, never a production URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = 'http://127.0.0.1:32771';
function launch(id, age = 0) {
  const entries = Object.entries({ vk_app_id: '54723764', vk_ts: String(Math.floor(Date.now()/1000)-age), vk_user_id: String(id) }).sort(([a],[b])=>a.localeCompare(b));
  const text = entries.map(([k,v])=>`${k}=${v}`).join('&');
  return `${text}&sign=${crypto.createHmac('sha256','entry-context-fixture').update(text).digest('base64url')}`;
}
async function auth(params, token = '') {
  return fetch(base+'/api/auth/vk', {method:'POST',headers:{'content-type':'application/json', ...(token ? {authorization:'Bearer '+token} : {})},body:JSON.stringify({launchParams:params})});
}
test('public About remains localized public HTML, not an auth/return forwarding endpoint', async()=>{
  for (const path of ['/about','/en/about']) {
    const response=await fetch(base+path+'?sign=secret-probe&vk_app_id=54723764&return=https://evil.invalid');
    assert.equal(response.status,200);
    const html=await response.text();
    assert.match(html,/<main id="main"><h1>/);
    assert.match(html,/href="\/(?:\?lang=en)?"/);
    assert.ok(!html.includes('secret-probe') && !html.includes('evil.invalid'));
    assert.ok(!html.includes('/app.js') && !html.includes('Bearer'));
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
});
test('valid signed launch B supersedes supplied cached website session A',async()=>{
  const a=await (await auth(launch(730001))).json();
  const b=await (await auth(launch(730002),a.token)).json();
  assert.ok(a.user.id && b.user.id && a.user.id!==b.user.id);
  const response=await fetch(base+'/api/summary/today',{headers:{authorization:'Bearer '+b.token}});
  assert.equal(response.status,200);
});
test('invalid signature and expired launch do not authenticate even with cached bearer',async()=>{
  const a=await (await auth(launch(730003))).json();
  for (const params of [launch(730004).replace('vk_user_id=730004','vk_user_id=730005'), launch(730006,9999999)]) {
    const response=await auth(params,a.token);
    assert.equal(response.status,401);
    assert.equal((await response.json()).token,undefined);
  }
});
test('anonymous About does not grant API access',async()=>{
  await fetch(base+'/about');
  const response=await fetch(base+'/api/summary/today');
  assert.equal(response.status,401);
});
