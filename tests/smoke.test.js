const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `kopilka-life-test-${Date.now()}.sqlite`);
process.env.BOT_TOKEN = 'test-bot-token';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.VK_APP_ID = '54723764';
process.env.VK_OAUTH_CLIENT_ID = '54723764';
process.env.VK_OAUTH_CLIENT_SECRET = 'test-vk-oauth-secret';
process.env.VK_SECURE_KEY = 'test-vk-secure-key';
process.env.VK_GROUP_ID = '240966481';
process.env.VK_GROUP_TOKEN = 'test-vk-group-token';
process.env.DEV_AUTH_ENABLED = 'true';
process.env.SCHEDULER_ENABLED = 'false';
process.env.RATE_LIMIT_API_MAX = '1000';
process.env.RATE_LIMIT_AUTH_MAX = '200';
process.env.RATE_LIMIT_DEV_MAX = '200';
const { createApp } = require('../src/server');
const { closeDb, getDb } = require('../src/db');
const { validateTelegramInitData } = require('../src/auth/validateTelegramInitData');
const { validateTelegramLogin } = require('../src/auth/validateTelegramLogin');
const { validateVkLaunchParams } = require('../src/auth/validateVkLaunchParams');
const { verifyState } = require('../src/auth/vkOAuth');
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

function makeVkLaunchParams(vkUserId, secureKey, overrides = {}) {
  const params = new URLSearchParams({
    vk_app_id: '54723764',
    vk_user_id: String(vkUserId),
    vk_language: 'ru',
    vk_ts: String(Math.floor(Date.now() / 1000)),
    ...overrides
  });
  const signParams = Array.from(params.entries()).filter(([key]) => key.startsWith('vk_')).sort(([a], [b]) => a.localeCompare(b));
  const query = new URLSearchParams(signParams).toString();
  const sign = crypto.createHmac('sha256', secureKey).update(query).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  params.set('sign', sign);
  return `?${params.toString()}`;
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
  assert(html.includes('/privacy.html'), 'privacy policy link exists');
  assert(html.includes('/terms.html'), 'terms link exists');
  assert(fs.readFileSync(path.join(process.cwd(), 'public', 'privacy.html'), 'utf8').includes('не хранит банковские карты'), 'privacy policy explains no payment data');
  assert(fs.readFileSync(path.join(process.cwd(), 'public', 'terms.html'), 'utf8').includes('ЖИЗНЬ — не деньги'), 'terms explain LIFE is not money');
  assert(css.includes(':focus-visible'), 'focus-visible styles exist');
  assert(css.includes('prefers-reduced-motion'), 'reduced motion CSS exists');
  assert(css.includes('qa-hint'), 'quick action description styles exist');
  assert(css.includes('language-switch'), 'language switcher styles exist');
  assert(html.includes('artifactsGrid'), 'path artifacts collection exists');
  assert(html.includes('artifactToast'), 'artifact unlock toast exists');
  assert(html.includes('enableVkReminders'), 'VK reminders opt-in button exists');
  assert(css.includes('artifact-card'), 'artifact cards are styled');
  assert(css.includes('artifact-mystery'), 'locked artifact mystery places are styled');
  assert(fs.existsSync(path.join(process.cwd(), 'public', 'assets', 'artifacts', 'cat_life_warmer.webp')), 'cat artifact image exists');
  assert(fs.existsSync(path.join(process.cwd(), 'public', 'assets', 'artifacts', 'nightingale_close_voices.webp')), 'nightingale artifact image exists');
  assert(fs.existsSync(path.join(process.cwd(), 'public', 'assets', 'artifacts', 'hedgehog_small_joy.webp')), 'hedgehog artifact image exists');
  assert(fs.existsSync(path.join(process.cwd(), 'public', 'assets', 'artifacts', 'bee_good_deed_honey.webp')), 'bee artifact image exists');
  const frontendI18n = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  assert(frontendI18n.includes('Встреча или звонок'), 'social contact quick action exists');
  assert(frontendI18n.includes('Время с родными'), 'family time quick action exists');
  const frontendApp = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  assert(frontendApp.includes('p.vkRefLink'), 'VK Mini App uses VK referral deeplink in profile');
  assert(frontendApp.includes('VKWebAppAllowMessagesFromGroup'), 'VK reminders request community message permission');
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
  assert.equal(validateTelegramLogin({ ...widget, refCode: 'ABC123', timezone: 'Europe/Moscow' }, 'test-bot-token').user.id, 999, 'app-local fields do not break Login Widget signature');
  assert.throws(() => validateTelegramLogin({ ...widget, hash: widget.hash.slice(0, -1) + (widget.hash.slice(-1) === 'a' ? 'b' : 'a') }, 'test-bot-token'), /invalid|hash/i, 'tampered Login Widget fails');
  assert.throws(() => validateTelegramLogin({ ...makeLoginWidget({ id: 777, first_name: 'Old', username: 'o' }, 'test-bot-token', 100), hash: '' }, 'test-bot-token'), /too old|hash/i, 'stale Login Widget rejected');
  const vkLaunch = makeVkLaunchParams(424242, 'test-vk-secure-key');
  assert.equal(validateVkLaunchParams(vkLaunch, 'test-vk-secure-key', { appId: '54723764' }).vkId, '424242', 'valid VK launch params pass');
  assert.equal(validateVkLaunchParams(`#/settings${vkLaunch}`, 'test-vk-secure-key', { appId: '54723764' }).vkId, '424242', 'VK launch params pass through hash-router URLs');
  assert.throws(() => validateVkLaunchParams(vkLaunch.replace('424242', '424243'), 'test-vk-secure-key', { appId: '54723764' }), /invalid|sign/i, 'tampered VK launch params fail');
  const cfgResp = await request('/api/config');
  assert.equal(cfgResp.res.status, 200, 'public config endpoint available');
  assert(typeof cfgResp.data.botUsername === 'string', 'public config exposes botUsername');
  assert.equal(cfgResp.data.vkGroupId, '240966481', 'public config exposes VK community id');
  assert.equal(cfgResp.data.vkMessagesEnabled, true, 'public config reports VK messages enabled when token is configured');
  let oauthStart = await request('/api/auth/vk-oauth/start', { method: 'POST', body: JSON.stringify({ action: 'auth', refCode: 'ABC123', timezone: 'Europe/Moscow' }) });
  assert.equal(oauthStart.res.status, 200, 'VK OAuth auth start returns URL');
  const oauthUrl = new URL(oauthStart.data.authUrl);
  assert.equal(oauthUrl.origin + oauthUrl.pathname, 'https://id.vk.ru/authorize', 'VK OAuth uses VK ID authorize endpoint');
  assert.equal(oauthUrl.searchParams.get('response_type'), 'code', 'VK OAuth uses code flow');
  assert.equal(oauthUrl.searchParams.get('client_id'), '54723764', 'VK OAuth uses configured app id');
  assert.equal(oauthUrl.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/vk-oauth/callback', 'VK OAuth uses backend callback');
  assert.equal(oauthUrl.searchParams.get('code_challenge_method'), 'S256', 'VK OAuth uses PKCE S256');
  assert.equal(verifyState(oauthUrl.searchParams.get('state')).refCode, 'ABC123', 'VK OAuth state keeps app context');
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
  oauthStart = await request('/api/auth/vk-oauth/start', { method: 'POST', headers: siteAuth, body: JSON.stringify({ action: 'link', timezone: 'UTC' }) });
  assert.equal(oauthStart.res.status, 200, 'VK OAuth link start requires and accepts current session');
  assert.equal(verifyState(new URL(oauthStart.data.authUrl).searchParams.get('state')).action, 'link', 'VK OAuth link state stores link action');
  let meResp = await request('/api/me', { headers: siteAuth });
  assert.equal(meResp.data.user.id, miniUserId, 'site session token is valid');
  const vkOnlyResp = await request('/api/auth/vk', { method: 'POST', body: JSON.stringify({ launchParams: makeVkLaunchParams(9001, 'test-vk-secure-key'), timezone: 'Europe/Moscow' }) });
  assert.equal(vkOnlyResp.res.status, 200, 'VK Mini App auth accepted');
  assert.equal(vkOnlyResp.data.user.vkLinked, true, 'VK user is marked linked');
  assert.equal(vkOnlyResp.data.user.timezone, 'Europe/Moscow', 'VK auth saves detected timezone');
  const vkOnlyAuth = { authorization: `Bearer ${vkOnlyResp.data.token}` };
  const vkMessageOptIn = await request('/api/settings/vk-messages', { method: 'POST', headers: vkOnlyAuth, body: JSON.stringify({ allowed: true, enableReminders: true }) });
  assert.equal(vkMessageOptIn.res.status, 200, 'VK message opt-in saved');
  assert.equal(vkMessageOptIn.data.user.vkMessagesAllowed, true, 'VK message opt-in is exposed');
  assert.equal(vkMessageOptIn.data.user.remindersEnabled, true, 'VK opt-in enables reminders');
  const vkScheduled = getDb().prepare("SELECT id FROM reminders WHERE user_id = ? AND status = 'scheduled'").get(vkOnlyResp.data.user.id);
  assert(vkScheduled?.id, 'VK opt-in schedules an evening reminder');
  getDb().prepare("UPDATE reminders SET due_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(vkScheduled.id);
  assert.equal(await sendDueReminders(), 1, 'VK due reminder is sent through dry-run community messages');
  const vkLinkResp = await request('/api/settings/link-vk', { method: 'POST', headers: siteAuth, body: JSON.stringify({ launchParams: makeVkLaunchParams(9002, 'test-vk-secure-key') }) });
  assert.equal(vkLinkResp.res.status, 200, 'Telegram account can link verified VK id');
  assert.equal(vkLinkResp.data.user.vkLinked, true, 'linked Telegram account reports vkLinked');
  const mergeTarget = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: makeInitData({ id: 124, first_name: 'Merge Target', username: 'merge_target' }, 'test-bot-token') }) });
  const mergeTargetAuth = { authorization: `Bearer ${mergeTarget.data.token}` };
  const disposableVk = await request('/api/auth/vk', { method: 'POST', body: JSON.stringify({ launchParams: makeVkLaunchParams(9003, 'test-vk-secure-key'), timezone: 'Europe/Moscow' }) });
  assert.equal(disposableVk.res.status, 200, 'disposable VK-only user can be created by VK login');
  const mergeLinkResp = await request('/api/settings/link-vk', { method: 'POST', headers: mergeTargetAuth, body: JSON.stringify({ launchParams: makeVkLaunchParams(9003, 'test-vk-secure-key') }) });
  assert.equal(mergeLinkResp.res.status, 200, 'Telegram account can claim an empty VK-only account');
  assert.equal(mergeLinkResp.data.user.vkLinked, true, 'merged Telegram account reports vkLinked');

  const primaryMerge = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: makeInitData({ id: 125, first_name: 'Primary Merge', username: 'primary_merge' }, 'test-bot-token') }) });
  const primaryAuth = { authorization: `Bearer ${primaryMerge.data.token}` };
  const sourceVk = await request('/api/auth/vk', { method: 'POST', body: JSON.stringify({ launchParams: makeVkLaunchParams(9010, 'test-vk-secure-key'), timezone: 'Europe/Moscow' }) });
  assert.equal(sourceVk.res.status, 200, 'source VK account created for data merge');
  const primaryId = primaryMerge.data.user.id;
  const sourceId = sourceVk.data.user.id;
  const dbForMerge = getDb();
  dbForMerge.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', 'primary joy', 1, '2026-08-10')").run(primaryId);
  dbForMerge.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'sleep', 'Сон', 'primary sleep', 3, '2026-08-11')").run(primaryId);
  dbForMerge.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', 'source joy', 1, '2026-08-10')").run(sourceId);
  dbForMerge.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'movement', 'Движение', 'source move', 2, '2026-08-10')").run(sourceId);
  dbForMerge.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'referral', 'Активный приглашённый человек', '', 1, '2026-08-10')").run(sourceId);
  dbForMerge.prepare("INSERT INTO weekly_contracts (user_id, title, target_value, week_start, week_end, status) VALUES (?, 'old contract', '3 days', '2026-08-03', '2026-08-09', 'completed')").run(sourceId);
  dbForMerge.prepare("INSERT INTO reminders (user_id, type, due_at, status) VALUES (?, 'evening', '2099-01-01T20:00:00.000Z', 'scheduled')").run(sourceId);
  const mergeOffer = await request('/api/settings/link-vk', { method: 'POST', headers: primaryAuth, body: JSON.stringify({ launchParams: makeVkLaunchParams(9010, 'test-vk-secure-key') }) });
  assert.equal(mergeOffer.res.status, 409, 'linking VK with data returns merge offer');
  assert.equal(mergeOffer.data.mergeRequired, true, 'merge offer is explicit');
  assert.equal(mergeOffer.data.preview.result.dedupedQuickEntries, 1, 'duplicate quick-action is detected');
  assert.equal(mergeOffer.data.preview.result.movedEntries, 2, 'unique quick/system entries will move');
  const mergeConfirm = await request('/api/account/merge-vk/confirm', { method: 'POST', headers: primaryAuth, body: JSON.stringify({ mergeToken: mergeOffer.data.mergeToken }) });
  assert.equal(mergeConfirm.res.status, 200, 'merge can be confirmed');
  assert.equal(mergeConfirm.data.user.vkLinked, true, 'primary account is linked to VK after merge');
  const mergedSummary = await request('/api/summary/today', { headers: primaryAuth });
  const mergedTotal = dbForMerge.prepare('SELECT COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ?').get(primaryId).total;
  assert.equal(mergedTotal, 7, 'merged total avoids duplicate joy double-count');
  const mergedJoy = dbForMerge.prepare("SELECT note FROM entries WHERE user_id = ? AND entry_date = '2026-08-10' AND type = 'joy'").get(primaryId);
  assert(mergedJoy.note.includes('primary joy') && mergedJoy.note.includes('source joy'), 'duplicate notes are preserved on target entry');
  assert.equal(dbForMerge.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(sourceId).count, 0, 'source account is removed after merge');
  assert.equal(dbForMerge.prepare('SELECT COUNT(*) AS count FROM weekly_contracts WHERE user_id = ?').get(primaryId).count, 1, 'source contract moved');
  assert.equal(dbForMerge.prepare("SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND status = 'scheduled'").get(primaryId).count, 0, 'future source reminder is dropped instead of duplicated');
  assert(mergedSummary.res.status === 200, 'merged account remains usable');

  loginResp = await request('/api/auth/telegram-login', { method: 'POST', body: JSON.stringify({ ...makeLoginWidget({ id: 123, first_name: 'Telegram', username: 'tg_user' }, 'test-bot-token'), hash: 'deadbeef' }) });
  assert.equal(loginResp.res.status, 401, 'forged site login rejected');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'sleep', note: 'smoke' }) });
  assert.equal(response.res.status, 201, 'entry created');
  assert.equal(response.data.summary.todayLife, 3, 'today balance updated');
  assert(response.data.summary.todayEntryTypes.includes('sleep'), 'summary exposes used quick-action types');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'sleep', note: 'duplicate' }) });
  assert.equal(response.res.status, 400, 'same quick-action type cannot be added twice per local day');
  response = await request('/api/summary/today', { headers: auth });
  assert.equal(response.data.todayLife, 3, 'duplicate quick-action does not increase today balance');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'honest_step', note: 'честный миллиметр' }) });
  assert.equal(response.res.status, 201, 'honest step entry created');
  assert.equal(response.data.summary.todayLife, 5, 'honest step adds visible progress');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'social_contact', note: 'созвон с давним другом' }) });
  assert.equal(response.res.status, 201, 'social contact entry created');
  assert.equal(response.data.summary.todayLife, 7, 'social contact adds life');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'family_time', note: 'вечер с родными' }) });
  assert.equal(response.res.status, 201, 'family time entry created');
  assert.equal(response.data.summary.todayLife, 9, 'family time adds life');
  assert(response.data.awardedArtifacts.some((artifact) => artifact.id === 'nightingale_close_voices'), 'social + family week unlocks nightingale artifact');
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'family_time', note: 'duplicate family' }) });
  assert.equal(response.res.status, 400, 'family time is still limited to once per local day');
  let artifactsResp = await request('/api/artifacts', { headers: auth });
  assert.equal(artifactsResp.res.status, 200, 'artifacts endpoint works');
  assert.equal(artifactsResp.data.artifacts.length, 8, 'artifact catalog returned');
  assert(artifactsResp.data.artifacts.some((artifact) => artifact.id === 'nightingale_close_voices' && artifact.unlocked), 'unlocked artifact appears in collection');
  assert(artifactsResp.data.artifacts.some((artifact) => artifact.id.startsWith('mystery_') && !artifact.unlocked), 'locked artifacts are returned as mystery slots');
  assert(!artifactsResp.data.artifacts.some((artifact) => !artifact.unlocked && /Пёс|Ленивец|Ёжик|Пчела|Медведь|Дракон/.test(artifact.title)), 'locked artifact titles are not revealed');
  assert(!artifactsResp.data.artifacts.some((artifact) => !artifact.unlocked && artifact.image), 'locked artifact images are not revealed');
  const dbForArtifacts = getDb();
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'important_task', 'Важное дело', '', 3, '2026-08-01')").run(userId);
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'food_water' }) });
  assert(response.data.awardedArtifacts.some((artifact) => artifact.id === 'cat_life_warmer'), '12 LIFE unlocks cat artifact');
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'rest', 'Отдых', '', 1, '2026-08-02')").run(userId);
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'rest', 'Отдых', '', 1, '2026-08-03')").run(userId);
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'rest' }) });
  assert(response.data.awardedArtifacts.some((artifact) => artifact.id === 'sloth_rest_blessing'), 'third rest unlocks sloth artifact');
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', '', 1, '2026-08-05')").run(userId);
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', '', 1, '2026-08-06')").run(userId);
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', '', 1, '2026-08-07')").run(userId);
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'joy' }) });
  assert(response.data.awardedArtifacts.some((artifact) => artifact.id === 'hedgehog_small_joy'), 'four joy days unlock hedgehog artifact');
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'kind_trace', 'Доброе дело', '', 1, '2026-08-08')").run(userId);
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'kind_trace', 'Доброе дело', '', 1, '2026-08-09')").run(userId);
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'kind_trace' }) });
  assert(response.data.awardedArtifacts.some((artifact) => artifact.id === 'bee_good_deed_honey'), 'third kind deed unlocks bee artifact');
  dbForArtifacts.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date, created_at) VALUES (?, 'hard_day', 'Сложный день', '', 1, '2026-08-04', '2026-08-04 10:00:00')").run(userId);
  response = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'gratitude' }) });
  assert(response.data.awardedArtifacts.some((artifact) => artifact.id === 'bear_warm_shelter'), 'entry after hard day unlocks bear artifact');
  response = await request('/api/summary/today', { headers: auth });
  assert(response.data.totalLife >= 14, 'SQLite persistence visible after artifact scenario');
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
  assert.equal(response.data.summary.totalLife, 35, 'contract points added after artifact smoke entries');
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
  // Timezone auto-detection: a provided zone is saved, and the default becomes UTC (not a hardcoded Novosibirsk).
  const tzUser = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: makeInitData({ id: 7009, first_name: 'TZ', username: 'tz_user' }, 'test-bot-token'), timezone: 'Europe/London' }) });
  assert.equal(tzUser.data.user.timezone, 'Europe/London', 'detected timezone saved on signup');
  const tzDefault = await request('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: makeInitData({ id: 7010, first_name: 'TZ2', username: 'tz_user2' }, 'test-bot-token') }) });
  assert.equal(tzDefault.data.user.timezone, 'UTC', 'default timezone is UTC when not provided');
  const refAProfile = await request('/api/profile', { headers: { authorization: `Bearer ${refAToken}` } });
  const refCodeA = refAProfile.data.profile.refCode;
  assert(refCodeA && refCodeA.length >= 4, 'referrer gets a ref code');
  assert(refAProfile.data.profile.refLink.includes('ref='), 'profile exposes ref link');
  assert(refAProfile.data.profile.vkRefLink.includes('vk.com/app54723764#ref='), 'profile exposes VK Mini App ref link');
  assert(refAProfile.data.profile.vkProfileLink.includes('vk.com/app54723764#profile='), 'profile exposes VK Mini App profile link');
  const publicShell = await fetch(`${baseUrl}/p/${refCodeA}`);
  assert.equal(publicShell.status, 200, 'public profile path serves SPA shell without auth');
  assert((await publicShell.text()).includes('/app.js'), 'public profile shell loads app script');
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
  const xssEntry = await request('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ type: 'dream_step', note: '<script>alert(1)</script> https://spam.example/buy' }) });
  assert.equal(xssEntry.res.status, 201, 'xss entry accepted');
  assert(!xssEntry.data.entry.note.includes('<script>'), 'script tag stripped from stored note');
  assert(!/https?:\/\//i.test(xssEntry.data.entry.note), 'url neutralized in stored note');
  response = await request('/telegram/webhook', { method: 'POST', body: JSON.stringify({ message: { text: '/start', chat: { id: 555 } } }) });
  assert.equal(response.res.status, 200, 'webhook /start smoke ok');
  // Inline mode (switchInlineQuery share): bot answers with an article.
  const inlineResp = await request('/telegram/webhook', { method: 'POST', body: JSON.stringify({ inline_query: { id: 'iq1', query: 'Текст https://life.blinddev.xyz?ref=X', from: { language_code: 'ru' } } }) });
  assert.equal(inlineResp.res.status, 200, 'inline_query answered ok');
  response = await request(`/api/dev/demo-user/${userId}`, { method: 'DELETE' });
  assert.equal(response.data.deleted, true, 'demo cleanup deleted user');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries WHERE user_id = ?').get(userId).count, 0, 'demo entries cleaned via cascade');
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
  console.log('smoke tests passed');
}
main().catch((error) => { console.error(error); closeDb(); process.exit(1); });
