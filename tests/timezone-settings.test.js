const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'timezone-settings-'));
fs.symlinkSync(path.join(root, 'migrations'), path.join(tmp, 'migrations'));
fs.symlinkSync(path.join(root, 'public'), path.join(tmp, 'public'));
for (const k of Object.keys(process.env)) if (!['PATH','HOME','TMPDIR','NODE_TEST_CONTEXT'].includes(k)) delete process.env[k];
Object.assign(process.env, { NODE_ENV:'test', DB_PATH:path.join(tmp,'qa.sqlite'), SESSION_SECRET:'timezone-test-secret', SCHEDULER_ENABLED:'false', RATE_LIMIT_API_MAX:'10000' });
process.chdir(tmp);
const {createApp} = require('../src/server');
const {getDb,closeDb} = require('../src/db');
const {updateSettings} = require('../src/services/usersService');
const {normalizeTimezone} = require('../src/time');
const {createToken} = require('../src/auth/session');
const {t} = require('../src/i18n');
let server, base;
test.before(async()=>{server=createApp().listen(3192,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:3192';});
test.after(async()=>{await new Promise(r=>server.close(r));closeDb();process.chdir(cwd);fs.rmSync(tmp,{recursive:true,force:true});});
function user(locale='ru'){return Number(getDb().prepare("INSERT INTO users(first_name,locale,timezone,reminders_enabled,evening_reminder_time) VALUES('Timezone fixture',?,'Europe/Kaliningrad',1,'19:15')").run(locale).lastInsertRowid);}
function snapshot(id){return {user:getDb().prepare('SELECT * FROM users WHERE id=?').get(id),reminders:getDb().prepare('SELECT * FROM reminders WHERE user_id=?').all(id)};}
const invalid = [undefined,null,'',' ','Mars/Olympus',' Europe/Moscow','Europe/Moscow ',{},[],42,false,'+03:00'];
test('manual service rejects malformed timezone before any settings write',()=>{const id=user();const before=snapshot(id);for(const timezone of invalid){assert.throws(()=>updateSettings(id,{timezone,remindersEnabled:false,eveningReminderTime:'08:01'}),{message:'error.invalidTimezone'});assert.deepEqual(snapshot(id),before);}});
test('authenticated RU/EN API rejects invalid timezone before clearing existing reminders',async()=>{for(const locale of ['ru','en']){const id=user(locale);getDb().prepare("INSERT INTO reminders(user_id,type,due_at,status) VALUES(?,'evening','2030-01-01T20:00:00.000Z','scheduled')").run(id);const before=snapshot(id);for(const timezone of invalid) for(const remindersEnabled of [false,true]){const res=await fetch(base+'/api/settings/reminders',{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${createToken(id)}`},body:JSON.stringify({timezone,remindersEnabled,eveningReminderTime:'08:01'})});assert.equal(res.status,400);assert.equal((await res.json()).error,t(locale,'error.invalidTimezone'));assert.notEqual(t(locale,'error.invalidTimezone'),'error.invalidTimezone');assert.deepEqual(snapshot(id),before);}}});
test('server catalog is complete, authenticated and read-only for older WebViews', async()=>{
  const id=user();const before=snapshot(id);
  const anonymous=await fetch(base+'/api/settings/timezones');assert.equal(anonymous.status,401);
  const response=await fetch(base+'/api/settings/timezones',{headers:{Authorization:`Bearer ${createToken(id)}`}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual((await response.json()).timezones,Intl.supportedValuesOf('timeZone'));assert.deepEqual(snapshot(id),before);
});
test('canonical zones and valid saved aliases persist exactly; launch fallback unchanged',()=>{const id=user();for(const timezone of ['UTC','Europe/Kaliningrad','Asia/Kathmandu','Asia/Calcutta','US/Eastern','Etc/GMT+5','Pacific/Kiritimati'])assert.equal(updateSettings(id,{timezone}).timezone,timezone);assert.equal(normalizeTimezone('Mars/Olympus'),'UTC');assert.equal(normalizeTimezone(undefined),'Asia/Novosibirsk');});
test('localized timezone labels, current aliases and complete supported choices',()=>{const context={window:{},Intl,Date};vm.runInNewContext(fs.readFileSync(path.join(root,'public/i18n.js'),'utf8'),context);const i=context.window.KopilkaI18n;assert.match(i.timezoneLabel('ru','Europe/Kaliningrad',new Date('2026-01-01')),/Калининград.*UTC\+02:00/);assert.match(i.timezoneLabel('en','Europe/Kaliningrad',new Date('2026-01-01')),/Kaliningrad.*UTC\+02:00/);for(const zone of ['Asia/Calcutta','US/Eastern','Etc/GMT+5']){assert(i.timezoneChoices(zone).includes(zone));assert(i.timezoneLabel('ru',zone));}const zones=i.timezoneChoices('US/Eastern');for(const zone of Intl.supportedValuesOf('timeZone'))assert(zones.includes(zone));assert(zones.includes('UTC'));});
