const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `kopilka-life-test-${Date.now()}.sqlite`);
process.env.BOT_TOKEN = 'test-bot-token';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DEV_AUTH_ENABLED = 'true';
process.env.SCHEDULER_ENABLED = 'false';
process.env.RATE_LIMIT_API_MAX = '1000';
process.env.RATE_LIMIT_AUTH_MAX = '200';
process.env.RATE_LIMIT_DEV_MAX = '200';
const { createApp } = require('../src/server');
const { closeDb, getDb } = require('../src/db');
const { validateTelegramInitData } = require('../src/auth/validateTelegramInitData');
const { validateTelegramLogin } = require('../src/auth/validateTelegramLogin');
const { sendDueReminders, nextDueAt } = require('../src/services/remindersService');
const { createRateLimiter } = require('../src/middleware/rateLimit');

function makeInitData(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'test-query');
  params.set('user', JSON.stringify(user));
  const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

// Builds a valid Telegram Login Widget callback payload. Secret = SHA256(botToken).
function makeLoginWidget(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { id: String(user.id), first_name: user.first_name, username: user.username || '', auth_date: String(authDate) };
  const dataCheckString = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

function testRateLimiterUnit() {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, keyPrefix: 'unit', keyFn: () => 'same' });
  let statusCode = 200;
  const req = { ip: '127.0.0.1', socket: {}, get: () => '' };
  const res = { set() {}, status(code) { statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  limiter(req, res, () => {});
  limiter(req, res, () => {});
  limiter(req, res, () => {});
  assert.equal(statusCode, 429, 'rate limiter blocks after max requests');
}

function testStaticAccessibility() {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');
  assert(html.includes('class="skip-link"'), 'skip link exists');
  assert(html.includes('role="status"'), 'status region has role=status');
  assert(html.includes('role="tablist"'), 'bottom navigation has tablist role');
  assert(html.includes('aria-controls="tab-today"'), 'tabs point to panels');
  assert(html.includes('Подсказка дня'), 'daily hint section exists');
  assert(html.includes('Шаблоны недельных договоров'), 'contract templates section exists');
  assert(html.includes('Недельный разбор'), 'weekly review section exists');
  assert(html.includes('Практики под цель'), 'goal practices section exists');
  assert(html.includes('видимый след жизни и заботы'), 'life asset is framed as visible progress, not a rating');
  assert(html.includes('Не обязательно. Приложение не хранит и не переводит деньги'), 'contract money field is optional and non-custodial');
  assert(html.includes('Быстро пополнить'), 'quick action fieldset exists');
  assert(css.includes(':focus-visible'), 'focus-visible styles exist');
  assert(css.includes('prefers-reduced-motion'), 'reduced motion CSS exists');
  assert(css.includes('qa-hint'), 'quick action description styles exist');
  assert(css.includes('language-switch'), 'language switcher styles exist');
  assert(html.includes('data-i18n'), 'static text is i18n-ready');
  // The dynamic counter must not sit inside a [data-i18n] element, or the
  // i18n pass would destroy <strong id="todayLife"> and crash renderSummary.
  assert(!/<p[^>]*data-i18n="todayAdded"[^>]*>[^<]*<strong id="todayLife"/.test(html), 'todayLife counter is not inside a data-i18n container');
  assert(html.includes('<span data-i18n="todayAdded">'), 'todayAdded label is its own i18n span');
}

async function main() {
  testRateLimiterUnit();
  testStaticAccessibility();
  assert.equal(nextDueAt('20:00', 'Asia/Novosibirsk', new Date('2026-01-01T12:00:00.000Z')), '2026-01-01T13:00:00.000Z', 'timezone due today works');
  assert.equal(nextDueAt('20:00', 'Asia/Novosibirsk', new Date('2026-01-01T14:00:00.000Z')), '2026-01-02T13:00:00.000Z', 'timezone due tomorrow works');

  const app = createApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(pathname, options = {}) {
    const res = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }
  const valid = makeInitData({ id: 123, first_name: 'Telegram', username: 'tg_user' }, 'test-bot-token');
  assert.equal(validateTelegramInitData(valid, 'test-bot-token').user.id, 123, 'valid Telegram initData passes');
  assert.throws(() => validateTelegramInitData(valid.replace(/.$/, 'x'), 'test-bot-token'), /invalid|hash/i, 'tampered initData fails');
  // Telegram Login Widget (site login): same secret scheme (SHA256 botToken), distinct from WebApp.
  const widget = makeLoginWidget({ id: 999, first_name: 'Site', username: 'site_user' }, 'test-bot-token');
  assert.equal(validateTelegramLogin(widget, 'test-bot-token').user.id, 999, 'valid Login Widget payload passes');
  assert.throws(() => validateTelegramLogin({ ...widget, hash: widget.hash.slice(0, -1) + (widget.hash.slice(-1) === 'a' ? 'b' : 'a') }, 'test-bot-token'), /invalid|hash/i, 'tampered Login Widget fails');
  assert.throws(() => validateTelegramLogin({ ...makeLoginWidget({ id: 777, first_name: 'Old', username: 'o' }, 'test-bot-token', 100), hash: '' }, 'test-bot-token'), /too old|hash/i, 'stale Login Widget rejected');
  const cfgResp = await request('/api/config');
  assert.equal(cfgResp.res.status, 200, 'public config endpoint available');
  assert(typeof cfgResp.data.botUsername === 'string', 'public config exposes botUsername');
  let response = await request('/api/auth/dev', { method: 'POST', body: JSON.stringify({ firstName: 'QA Demo' }) });
  assert.equal(response.res.status, 200, 'dev auth enabled');
  const token = response.data.token;
  const userId = response.data.user.id;
  const auth = { authorization: `Bearer ${token}` };
  // Site login end-to-end: same telegram_id as Mini App -> same account (unified).
  // 1) Mini App login creates/returns the Telegram user (id 123).
  let miniResp = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: valid }) });
  assert.equal(miniResp.res.status, 200, 'mini app telegram auth accepted');
  const miniUserId = miniResp.data.user.id;
  // 2) Site Login Widget with the SAME telegram id resolves to the SAME account.
  let loginResp = await request('/api/auth/telegram-login', { method: 'POST', body: JSON.stringify(makeLoginWidget({ id: 123, first_name: 'Telegram', username: 'tg_user' }, 'test-bot-token')) });
  assert.equal(loginResp.res.status, 200, 'site telegram-login accepted');
  assert.equal(loginResp.data.user.id, miniUserId, 'site login reuses the same account as Mini App (unified by telegram_id)');
  const siteToken = loginResp.data.token;
  const siteAuth = { authorization: `Bearer ${siteToken}` };
  let meResp = await request('/api/me', { headers: siteAuth });
  assert.equal(meResp.data.user.id, miniUserId, 'site session token is valid');
  loginResp = await request('/api/auth/telegram-login', { method: 'POST', body: JSON.stringify({ ...makeLoginWidget({ id: 123, first_name: 'Telegram', username: 'tg_user' }, 'test-bot-token'), hash: 'deadbeef' }) });
  assert.equal(loginResp.res.status, 401, 'forged site login rejected');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'sleep', note: 'smoke' }) });
  assert.equal(response.res.status, 201, 'entry created');
  assert.equal(response.data.summary.todayLife, 3, 'today balance updated');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'honest_step', note: 'честный миллиметр' }) });
  assert.equal(response.res.status, 201, 'honest step entry created');
  assert.equal(response.data.summary.todayLife, 5, 'honest step adds visible progress');
  response = await request('/api/summary/today', { headers: auth });
  assert.equal(response.data.totalLife, 5, 'SQLite persistence visible');
  response = await request('/api/product?goal=sleep', { headers: auth });
  assert(response.data.dailyHint?.title, 'daily hint returned');
  assert(response.data.dailyHint.title !== 'Достаточно на сегодня', 'enough-for-today is not used as an action-like hint title');
  assert(response.data.contractTemplates.some((template) => template.id === 'kind-trace-3-of-7' && template.title === 'Доброе дело 3 из 7'), 'kind trace contract template returned with clear name');
  assert(response.data.contractTemplates.some((template) => template.id === 'honest-step-4-of-7' && template.title === 'Честный шаг 4 из 7'), 'honest step contract template returned with clear name');
  assert(response.data.contractTemplates.length >= 5, 'contract templates returned');
  assert(response.data.weeklyReview.summaryText.includes('ЖИЗНЬ'), 'weekly review returned');
  assert.equal(response.data.practices.goal, 'sleep', 'goal practices selected');
  response = await request('/api/product/practices?goal=dream', { headers: auth });
  assert(response.data.practices.some((text) => text.includes('мечт')), 'dream practices returned');
  response = await request('/api/product/practices?goal=kindness', { headers: auth });
  assert(response.data.practices.some((text) => text.includes('тёплое') || text.includes('добро')), 'kindness practices returned');
  response = await request('/api/product/practices?goal=honesty', { headers: auth });
  assert(response.data.practices.some((text) => text.includes('сигнал') && text.includes('шум')), 'honesty/compass practices returned');
  // i18n: create an EN demo user and verify localized product content + entry title.
  let enResp = await request('/api/auth/dev', { method: 'POST', body: JSON.stringify({ firstName: 'EN Demo', locale: 'en' }) });
  assert.equal(enResp.res.status, 200, 'dev auth en enabled');
  const enToken = enResp.data.token;
  const enAuth = { authorization: `Bearer ${enToken}` };
  assert.equal(enResp.data.user.locale, 'en', 'en locale persisted');
  enResp = await request('/api/entries', { method: 'POST', headers: enAuth, body: JSON.stringify({ type: 'kind_trace' }) });
  assert.equal(enResp.res.status, 201, 'en entry created');
  assert.equal(enResp.data.summary.todayEntries[0].title, 'Kind deed', 'en entry title localized');
  enResp = await request('/api/product?goal=sleep', { headers: enAuth });
  assert.equal(enResp.data.contractTemplates.find((t) => t.id === 'kind-trace-3-of-7').title, 'Kind deed 3 of 7', 'en contract template localized');
  assert(enResp.data.dailyHint?.title, 'en daily hint returned');
  assert(!/[А-Яа-яЁё]/.test(enResp.data.weeklyReview.summaryText), 'en weekly review has no Russian');
  enResp = await request('/api/product/practices?goal=kindness', { headers: enAuth });
  assert(enResp.data.practices.some((text) => /warm|kind|thank/i.test(text)), 'en kindness practices returned');
  response = await request('/api/contracts', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Сон', targetValue: '5 дней из 7', stakeAmount: '500', stakeCurrency: 'RUB', rewardDescription: 'чай', fundDescription: 'фонд' }) });
  assert.equal(response.res.status, 201, 'contract created');
  const contractId = response.data.contract.id;
  assert.equal(typeof response.data.contract.isLastDay, 'boolean', 'contract exposes isLastDay flag');
  assert.equal(typeof response.data.contract.isOver, 'boolean', 'contract exposes isOver flag');
  response = await request(`/api/contracts/${contractId}/close`, { method: 'POST', headers: auth, body: JSON.stringify({ status: 'completed' }) });
  assert.equal(response.res.status, 200, 'contract closed');
  assert.equal(response.data.summary.totalLife, 15, 'contract points added');
  response = await request('/api/settings/reminders', { method: 'POST', headers: auth, body: JSON.stringify({ remindersEnabled: true, eveningReminderTime: '20:00', timezone: 'Asia/Novosibirsk' }) });
  assert.equal(response.res.status, 200, 'settings saved');
  const db = getDb();
  const scheduled = db.prepare("SELECT due_at FROM reminders WHERE user_id = ? AND status = 'scheduled'").get(userId);
  assert(scheduled?.due_at, 'timezone reminder scheduled');
  db.prepare("INSERT OR IGNORE INTO reminders (user_id, type, due_at, status) VALUES (?, 'evening', ?, 'scheduled')").run(userId, '2000-01-01T00:00:00.000Z');
  assert.equal(await sendDueReminders(), 1, 'due reminder sent once');
  assert.equal(await sendDueReminders(), 0, 'duplicate reminder not sent');
  // ---- Referral program ----
  // Referrer A (real Telegram user) creates an account and gets a ref code.
  const refA = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: makeInitData({ id: 7001, first_name: 'Referrer A', username: 'ref_a' }, 'test-bot-token') }) });
  const refAToken = refA.data.token; const refAId = refA.data.user.id;
  const refAProfile = await request('/api/profile', { headers: { authorization: `Bearer ${refAToken}` } });
  const refCodeA = refAProfile.data.profile.refCode;
  assert(refCodeA && refCodeA.length >= 4, 'referrer gets a ref code');
  assert(refAProfile.data.profile.refLink.includes('ref='), 'profile exposes ref link');
  // Referred B (real Telegram user) signs up with A's code, then makes a first entry -> A gets +1 LIFE.
  const refB = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: makeInitData({ id: 7002, first_name: 'Referred B', username: 'ref_b' }, 'test-bot-token'), refCode: refCodeA }) });
  const refBToken = refB.data.token; const refBId = refB.data.user.id;
  const refBEntry = await request('/api/entries', { method: 'POST', headers: { authorization: `Bearer ${refBToken}` }, body: JSON.stringify({ type: 'sleep' }) });
  assert.equal(refBEntry.res.status, 201, 'referred user first entry ok');
  const refASummary = await request('/api/summary/today', { headers: { authorization: `Bearer ${refAToken}` } });
  assert(refASummary.data.totalLife >= 1, 'referrer credited +1 LIFE after first referred action');
  // Second entry by B must NOT grant again (bonus once).
  await request('/api/entries', { method: 'POST', headers: { authorization: `Bearer ${refBToken}` }, body: JSON.stringify({ type: 'movement' }) });
  const refAProfile2 = await request('/api/profile', { headers: { authorization: `Bearer ${refAToken}` } });
  assert.equal(refAProfile2.data.profile.activeReferred, 1, 'active referred count = 1');
  // Public profile exposes aggregates but NEVER personal notes.
  const publicResp = await request(`/api/public/${refCodeA}`);
  assert.equal(publicResp.res.status, 200, 'public profile reachable by code');
  assert(publicResp.data.profile.today && typeof publicResp.data.profile.today.todayLife === 'number', 'public profile has today stats');
  assert(publicResp.data.profile.week && typeof publicResp.data.profile.week.activeDays === 'number', 'public profile has week stats');
  const publicBody = JSON.stringify(publicResp.data);
  assert(!publicBody.includes('"note"'), 'public profile never leaks personal notes');
  const badPublic = await request('/api/public/NO_SUCH_CODE_ZZZZ');
  assert.equal(badPublic.res.status, 404, 'unknown public profile code -> 404');
  db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(refAId, refBId);
  // Sanitization: XSS/script and URL/spam in notes are neutralized server-side.
  const xssEntry = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'joy', note: '<script>alert(1)</script> https://spam.example/buy' }) });
  assert.equal(xssEntry.res.status, 201, 'xss entry accepted');
  assert(!xssEntry.data.entry.note.includes('<script>'), 'script tag stripped from stored note');
  assert(!/https?:\/\//i.test(xssEntry.data.entry.note), 'url neutralized in stored note');
  response = await request('/telegram/webhook', { method: 'POST', body: JSON.stringify({ message: { text: '/start', chat: { id: 555 } } }) });
  assert.equal(response.res.status, 200, 'webhook /start smoke ok');
  response = await request(`/api/dev/demo-user/${userId}`, { method: 'DELETE' });
  assert.equal(response.data.deleted, true, 'demo cleanup deleted user');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries WHERE user_id = ?').get(userId).count, 0, 'demo entries cleaned via cascade');
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
  console.log('smoke tests passed');
}
main().catch((error) => { console.error(error); closeDb(); process.exit(1); });
