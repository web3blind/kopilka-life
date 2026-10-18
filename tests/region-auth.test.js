const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_ENABLED = 'true';
process.env.GEO_COUNTRY_DB_PATH = path.join(process.env.TMPDIR, 'missing-country.mmdb');
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR, 'region-auth-')), 'db.sqlite');
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.VK_SECURE_KEY = 'test-vk-geo-shell-key';
process.env.VK_APP_ID = '54723764';
const { siteRegion, countryFromIp } = require('../src/services/countryService');
const { landingHtml } = require('../src/services/landingHtmlService');
const { createApp } = require('../src/server');
test('account linking lives only in authenticated profile with regional Google gating', () => {
  const global = landingHtml('global');
  const regional = landingHtml('ru');
  for (const html of [global, regional]) {
    const settings = html.split('<section id="tab-settings"')[1].split('<section id="tab-support"')[0];
    const profile = html.split('<section id="tab-profile"')[1].split('</main>')[0];
    const anonymous = html.split('<section id="loginScreen"')[1].split('<div class="app-shell" id="appShell" hidden>')[0];
    assert.doesNotMatch(settings, /accountLinksHeading|linkEmailForm|linkVkAccount|linkGoogleAccount/);
    assert.doesNotMatch(anonymous, /accountLinksHeading|linkEmailForm|linkVkAccount|linkGoogleAccount/);
    for (const id of ['accountLinksHeading', 'linkVkAccount', 'linkEmailForm', 'linkEmailCodeForm', 'linkGoogleAccount']) {
      if (id === 'linkGoogleAccount' && html === regional) continue;
      assert.match(profile, new RegExp(`id="${id}"`));
      assert.equal(html.split(`id="${id}"`).length, 2, `${id} occurs exactly once`);
    }
    assert.match(html, /id="appShell" hidden/);
    assert.equal(html.split('https://db-ip.com').length, 3, 'attribution on login and app views');
  }
  assert.doesNotMatch(regional, /id="linkGoogleAccount"/);
});

test('unknown country fails closed on site and login routes, not Mini App', async () => {
  assert.equal(siteRegion('RU'), 'ru');
  assert.equal(siteRegion('US'), 'global');
  assert.equal(siteRegion(countryFromIp('8.8.8.8')), 'ru');
  assert.match(landingHtml('global'), /id="googleLoginButton"/);
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/', '/index.html', '/p/TEST']) {
      const res = await fetch(base + route);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(html, /id="emailLoginForm"/);
      assert.match(html, /id="vkLoginButton"/);
      assert.doesNotMatch(html, /id="googleLoginButton"|id="telegramLoginButton"|id="linkGoogleAccount"/);
    }
    const post = (route) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await post('/api/auth/telegram-login')).status, 403);
    assert.equal((await post('/api/auth/google/start')).status, 403);
    assert.equal((await post('/api/auth/telegram')).status, 401);
    assert.equal((await post('/api/auth/vk')).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    require('../src/db').closeDb();
    fs.rmSync(path.dirname(process.env.DB_PATH), { recursive: true, force: true });
  }
});
test('official MaxMind MMDB fixture classifies RU, JP, US', () => {
  const fixture = path.join(__dirname, 'fixtures', 'GeoIP2-Country-Test.mmdb');
  assert.equal(countryFromIp('2a02:d0c0::', fixture), 'RU');
  assert.equal(countryFromIp('2001:218::1', fixture), 'JP');
  assert.equal(countryFromIp('214.78.120.0', fixture), 'US');
  assert.equal(siteRegion(countryFromIp('2a02:d0c0::', fixture)), 'ru');
});
test('real MMDB controls HTML and website auth from trusted proxy IP', async () => {
  const config = require('../src/config');
  const originalDb = config.dbPath, originalGeo = config.geoCountryDbPath;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'geo-http-'));
  config.dbPath = path.join(dir, 'db.sqlite');
  config.geoCountryDbPath = path.join(__dirname, 'fixtures', 'GeoIP2-Country-Test.mmdb');
  let server;
  try {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const visit = (ip, path = '/') => fetch(base + path, { headers: { 'X-Forwarded-For': ip } });
    const ru = await (await visit('2a02:d0c0::')).text();
    const spoofed = await (await visit('214.78.120.0, 2a02:d0c0::')).text();
    const us = await (await visit('214.78.120.0')).text();
    assert.doesNotMatch(spoofed, /id="telegramLoginButton"|id="googleLoginButton"/);
    assert.doesNotMatch(ru, /id="telegramLoginButton"|id="googleLoginButton"/);
    assert.match(us, /id="telegramLoginButton"/);
    assert.match(us, /id="googleLoginButton"/);
    const blocked = await fetch(base + '/api/auth/google/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '2a02:d0c0::' }, body: '{}' });
    assert.equal(blocked.status, 403);
    const allowed = await fetch(base + '/api/auth/google/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '214.78.120.0' }, body: '{}' });
    assert.equal(allowed.status, 200);
    assert.equal(new URL((await allowed.json()).launchUrl).pathname, '/api/auth/google/authorize');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    require('../src/db').closeDb();
    config.dbPath = originalDb; config.geoCountryDbPath = originalGeo;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VK landing never reads IP country and does not expose DB-IP links while web attribution remains', async () => {
  const config = require('../src/config');
  const previous = { db: config.dbPath, geo: config.geoCountryDbPath };
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'vk-geo-http-'));
  config.dbPath = path.join(dir, 'db.sqlite');
  config.geoCountryDbPath = path.join(__dirname, 'fixtures', 'GeoIP2-Country-Test.mmdb');
  const signed = new URLSearchParams({ vk_app_id: '54723764', vk_user_id: '987654', vk_ts: String(Math.floor(Date.now()/1000)), vk_platform: 'desktop_web' });
  const check = [...signed].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('&');
  signed.set('sign', crypto.createHmac('sha256', config.vkSecureKey).update(check).digest('base64url'));
  let server;
  try {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (ip, suffix) => fetch(base + suffix, { headers: { 'X-Forwarded-For': ip } });
    const vkUs = await (await get('214.78.120.0', '/?' + signed)).text();
    const vkRu = await (await get('2a02:d0c0::', '/?' + signed)).text();
    for (const html of [vkUs, vkRu]) {
      assert.match(html, /id="vkLoginButton"/);
      assert.doesNotMatch(html, /db-ip\.com|id="loginIpAttribution"|id="appIpAttribution"|id="googleLoginButton"|id="telegramLoginButton"/);
    }
    const invalid = new URLSearchParams(signed); invalid.set('sign', 'invalid');
    const forged = await (await get('214.78.120.0', '/?' + invalid)).text();
    assert.match(forged, /db-ip\.com|id="googleLoginButton"/);
    const web = await (await get('214.78.120.0', '/')).text();
    assert.match(web, /https:\/\/db-ip\.com/);
    const policy = await (await get('214.78.120.0', '/privacy.html')).text();
    assert.match(policy, /href="https:\/\/db-ip\.com"/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    require('../src/db').closeDb();
    config.dbPath = previous.db; config.geoCountryDbPath = previous.geo;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
