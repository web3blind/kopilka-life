const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(platform = 'vk', merge = true) {
  const nodes = new Map();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: '',
      classList: { toggle() {}, add() {}, remove() {} }, dataset: {}, attributes: {}, setAttribute(k,v) { this.attributes[k]=v; }, focus() {}, getClientRects() { return [{}]; } });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ window: { location: { search: '', hash: '', origin: 'https://local.test' },
    localStorage: { getItem() { return null; }, setItem() {} }, addEventListener() {},
    ...(platform === 'telegram' ? { Telegram: { WebApp: { initData: 'fixture' } } } : {}) },
    document: { getElementById: el, querySelector() { return null; }, querySelectorAll() { return []; }, activeElement: null },
    navigator: {}, URL, URLSearchParams, Intl, Date, setTimeout, clearTimeout, console });
  const run = code => vm.runInContext(code, ctx);
  run(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'));
  const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const boundary = src.indexOf('(async () => {\n  fireVkBridgeInit();');
  assert.ok(boundary > 0);
  run(src.slice(0, boundary));
  run(`clientLog=()=>{}; setVkAttributionVisibility=()=>{}; applyStaticI18n=()=>{};
    isVkMiniApp=()=>${platform === 'vk'}; initVkBridge=async()=>{}; vkLaunchParams=()=> 'fixture';
    captureRefCode=()=>''; detectTimezone=()=> 'UTC'; rememberRecoveryNotice=()=>{};
    setVerifiedUser=u=>{state.user=u}; loadData=async()=>{if(!state.user)state.user={id:1,locale:'ru'}};
    renderSettings=()=>{}; switchTab=()=>{}; showLoginScreen=async()=>{$('appShell').hidden=true;$('loginScreen').hidden=false};
    globalThis.readyWrites=0; const realSetStatus=setStatus;
    setStatus=(...args)=>{if(args[2]==='ready')readyWrites++;realSetStatus(...args)};
    const saved=new Map(${merge} ? [['kopilkaVkMergeToken','stale-fixture-merge-token']] : []);
    storage.get=k=>saved.get(k)||'';
    storage.set=(k,v)=>saved.set(k,v); storage.remove=k=>saved.delete(k);
    api=async path=>path.startsWith('/api/auth/') || path==='/api/settings/link-vk' ? {token:'fixture',user:{id:1,locale:'ru'}} :
      new Promise((resolve,reject)=>{globalThis.resolveMerge=resolve;globalThis.rejectMerge=reject});
    ${platform === 'site' ? "state.token='cached-fixture';" : ''}`);
  return { ctx, el, run };
}

async function mergePending(h) {
  const pending = h.run('start()');
  for (let i = 0; i < 30 && !h.ctx.rejectMerge; i++) await Promise.resolve();
  assert.equal(typeof h.ctx.rejectMerge, 'function', 'real start must reach real loadPendingMerge');
  return { pending };
}

test('7615502: actual VK auth/start/deferred stale merge cannot resurrect dismissed Ready', async () => {
  const h = harness();
  const { pending } = await mergePending(h);
  // On the defective app this is the first dismissible Ready from handleVkAuth.
  const early = h.el('statusRegion').textContent;
  if (early) {
    assert.equal(h.el('dismissStatus').hidden, false);
    h.el('dismissStatus').onclick();
    assert.equal(h.el('statusRegion').textContent, '');
  }
  h.ctx.rejectMerge(Error('expired merge offer'));
  await pending;
  if (early) assert.equal(h.el('statusRegion').textContent, '', 'dismissed Ready must not reappear after stale merge rejection');
  assert.equal(h.ctx.readyWrites, 1, 'startup owns exactly one final Ready');
  assert.equal(early, '', 'Ready is not final while merge preview is pending');
  assert.equal(h.el('dismissStatus').hidden, false);
  h.el('dismissStatus').onclick();
  await Promise.resolve();
  assert.equal(h.el('statusRegion').textContent, '');
  await h.run('start()'); // New startup is allowed to announce Ready again.
  assert.equal(h.ctx.readyWrites, 2);
});

for (const platform of ['vk', 'telegram', 'site']) {
  test(`${platform} startup without a merge still announces one Ready`, async () => {
    const h = harness(platform, false);
    await h.run('start()');
    assert.equal(h.ctx.readyWrites, 1);
    assert.equal(h.el('dismissStatus').hidden, false);
  });
}

test('standalone handleVkAuth retains its Ready and new-session announcement', async () => {
  const h = harness('vk', false);
  await h.run('handleVkAuth()');
  assert.equal(h.ctx.readyWrites, 1);
  h.el('dismissStatus').onclick();
  assert.equal(h.el('statusRegion').textContent, '');
  await h.run('handleVkAuth()');
  assert.equal(h.ctx.readyWrites, 2);
  assert.equal(h.el('dismissStatus').hidden, false);
});

test('valid merge stays visible and non-dismissible rather than becoming Ready', async () => {
  const h = harness();
  const { pending } = await mergePending(h);
  h.ctx.resolveMerge({ mergeToken: 'fixture-offer', preview: {} });
  await pending;
  assert.equal(h.ctx.readyWrites, 0);
  assert.equal(h.el('statusRegion').textContent, h.run("L('mergeNeedsConfirmation')"));
  assert.equal(h.el('dismissStatus').hidden, true);
  assert.ok(h.run('state.pendingMerge'));
});

test('data load failure never announces Ready', async () => {
  const h = harness('vk', false);
  h.run("loadData=async()=>{throw Error('summary unavailable')}");
  await h.run('start()');
  assert.equal(h.ctx.readyWrites, 0);
  assert.equal(h.el('appShell').hidden, true);
  assert.ok(h.el('loginStatus').textContent);
});

test('link-only VK auth preserves its linked notice instead of Ready', async () => {
  const h = harness('vk', false);
  h.run('renderAll=()=>{}');
  await h.run('handleVkAuth({linkOnly:true})');
  assert.equal(h.ctx.readyWrites, 0);
  assert.equal(h.el('statusRegion').textContent, h.run("L('vkLinked')"));
});

test('auth failure remains an error and never announces Ready', async () => {
  const h = harness('vk', false);
  h.run("api=async()=>{throw Error('auth unavailable')}");
  await h.run('start()');
  assert.equal(h.ctx.readyWrites, 0);
  assert.equal(h.el('appShell').hidden, true);
  assert.ok(h.el('loginStatus').textContent);
});
