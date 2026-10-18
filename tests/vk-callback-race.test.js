'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-callback-race-'));
const configPath = require.resolve('../src/config');
const config = { nodeEnv: 'test', isProduction: false, dbPath: path.join(tmp, 'qa.sqlite'),
  sessionSecret: 'fixture-secret-only', sessionMaxAgeSeconds: 600, vkGroupToken: '',
  vkOAuthClientId: 'fixture', vkOAuthAuthorizeUrl: 'https://provider.invalid/authorize',
  webappUrl: 'http://127.0.0.1:3186',
  rateLimits: { storyWindowMs: 60000, storyMax: 200, authWindowMs: 60000, authMax: 200, devWindowMs: 60000, devMax: 200 } };
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: config };
const oauth = require('../src/auth/vkOAuth');
const { getDb, closeDb } = require('../src/db');
const { upsertTelegramUser } = require('../src/services/usersService');
const { createToken } = require('../src/auth/session');
const router = require('../src/routes/api');
const binding = 'b'.repeat(48);
const cookie = `kopilka_oauth_browser=${binding}`;
let exchanges = 0, release, providerUserId = '780011', providerFailure = false;
const provider = express(); provider.use(express.urlencoded({ extended: false }));
provider.post('/token', async (req, res) => { exchanges++; assert(req.body.code_verifier); if (release) await new Promise(resolve => { release.resolve = resolve; }); res.json(providerFailure ? { error: 'private-provider-token-must-not-leak' } : { user_id: providerUserId, access_token: 'fixture-only' }); });
const listen = app => new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const stop = server => new Promise(resolve => server.close(resolve));
function start(action = 'auth', userId = null) {
  const intent = oauth.createOAuthIntent({ action, userId });
  const state = new URL(oauth.beginOAuthIntent(intent.intent, binding)).searchParams.get('state');
  return { body: { state, code: 'fixture-code', device_id: 'fixture-device' }, channel: intent.channel };
}
function snapshot() { return JSON.stringify(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, getDb().prepare(`SELECT * FROM "${name}"`).all()])); }
test('speculative duplicate GETs are inert; explicit same-origin JSON POST alone completes once', async () => {
  const ps = await listen(provider); config.vkOAuthTokenUrl = `http://127.0.0.1:${ps.address().port}/token`;
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await listen(app); const base = `http://127.0.0.1:${server.address().port}`; config.webappUrl = base;
  const post = (body, headers = {}) => fetch(base+'/api/auth/vk-oauth/complete', { method:'POST', headers:{ origin:base, 'content-type':'application/json', cookie, ...headers }, body:JSON.stringify(body) });
  try {
    const flow = start(); const before = snapshot();
    const url = base+'/api/auth/vk-oauth/callback?'+new URLSearchParams(flow.body);
    const responses = await Promise.all([fetch(url,{headers:{cookie}}), fetch(url,{headers:{cookie, purpose:'prefetch'}})]);
    for (const response of responses) {
      assert.equal(response.status,200); assert.equal(response.headers.get('set-cookie'),null);
      assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
      assert.match(await response.text(), /\/api\/auth\/vk-oauth\/complete/);
    }
    assert.equal(snapshot(),before,'GET must not consume state, prune rows, issue proof or write account');
    assert.equal(exchanges,0);
    for (const origin of ['https://evil.invalid','null','']) assert.equal((await post(flow.body,{origin})).status,403);
    assert.equal((await post(flow.body,{'content-type':'text/plain'})).status,415);
    assert.equal(snapshot(),before);
    assert.equal((await post(flow.body,{cookie:''})).status,400);
    assert.equal(snapshot(),before);
    release = {};
    const pending = post(flow.body);
    while (!release.resolve) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await post(flow.body)).status,400,'concurrent POST replay rejected before provider exchange');
    const duringExchange = snapshot(); await fetch(url,{headers:{cookie}}); assert.equal(snapshot(),duringExchange); assert.equal(exchanges,1);
    release.resolve(); release=null;
    const completed = await pending; const result = await completed.json();
    assert.equal(completed.status,200); assert.equal(result.channel,flow.channel); assert.equal(result.action,'auth'); assert(result.token);
    assert.equal(exchanges,1); assert.equal((await post(flow.body)).status,400);
    providerUserId = '780012';
    const target = upsertTelegramUser({ id: 88111, first_name:'Fixture' }); const linked = start('link',target.id);
    const proof = await (await post(linked.body)).json(); assert(proof.linkProof); assert.equal(proof.action,'link'); assert.equal(proof.channel,linked.channel);
    assert.equal(getDb().prepare('SELECT vk_id FROM users WHERE id=?').get(target.id).vk_id,null,'completion never links account');
    const finalize = (token) => fetch(base+'/api/auth/vk-oauth/finalize-link',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({proof:proof.linkProof})});
    assert.equal((await finalize('')).status,401);
    const other = upsertTelegramUser({id:88112,first_name:'Other'}); assert.equal((await finalize(createToken(other.id))).status,403);
    const finalized = await finalize(createToken(target.id)); assert.equal(finalized.status,200);
    assert.equal(String(getDb().prepare('SELECT vk_id FROM users WHERE id=?').get(target.id).vk_id),providerUserId);
    assert.equal((await finalize(createToken(target.id))).status,400);
    const denied = start(); const count = exchanges;
    const cancellation = await (await post({...denied.body,error:'access_denied',error_description:'secret-provider-data'})).json();
    assert.equal(cancellation.channel,denied.channel); assert(cancellation.error); assert.equal(exchanges,count);
    assert.equal((await post(denied.body)).status,400);
    providerFailure = true; const failed = start();
    const failedResult = await (await post(failed.body)).json();
    assert.equal(failedResult.channel,failed.channel); assert(failedResult.error);
    assert(!JSON.stringify(failedResult).includes('private-provider-token'));
    assert.equal(exchanges,count+1); assert.equal((await post(failed.body)).status,400);
  } finally { if(release?.resolve) release.resolve(); await stop(server); await stop(ps); closeDb(); fs.rmSync(tmp,{recursive:true,force:true}); }
});
