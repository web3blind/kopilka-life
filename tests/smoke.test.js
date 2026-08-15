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
  let response = await request('/api/auth/dev', { method: 'POST', body: JSON.stringify({ firstName: 'QA Demo' }) });
  assert.equal(response.res.status, 200, 'dev auth enabled');
  const token = response.data.token;
  const userId = response.data.user.id;
  const auth = { authorization: `Bearer ${token}` };
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
