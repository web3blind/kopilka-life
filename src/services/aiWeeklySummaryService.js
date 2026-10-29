const { getDb } = require('../db');
const config = require('../config');
const { normalizeTimezone, localDateString } = require('../time');
const { normalizeLocale } = require('../i18n');
const { ENTRY_TYPES, entryTitle } = require('./entriesService');
const provider = require('./aiWeeklyProvider');
const prompts = require('./aiAssistantPrompts');
const CONSENT_VERSION = '2026-10-29';
const QUOTA_MS = 168 * 60 * 60 * 1000;
const TYPES_SQL = ENTRY_TYPES.map(() => '?').join(',');
function fail(code, status = 400) { const error = new Error(code); error.safeCode = code; error.status = status; return error; }
function selection(input = {}, strict = false) {
  const days = input.days === undefined && !strict ? 7 : input.days;
  const topic = input.topic === undefined && !strict ? 'summary' : input.topic;
  if ((typeof days !== 'number' && (strict || typeof days !== 'string' || !/^[1-9]\d?$/.test(days))) ||
      !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 30 ||
      typeof topic !== 'string' || !Object.hasOwn(prompts.TOPICS,topic)) throw fail('SELECTION_INVALID');
  return {days:Number(days),topic};
}
function addDays(day, count) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
// Kept as an internal compatibility export; this is now the selected calendar window.
function completedPeriod(timezone, now = new Date(), days = 7, topic = 'summary') {
  const chosen = selection({days,topic}), zone = normalizeTimezone(timezone);
  const end = localDateString(now,zone), start = addDays(end,1-chosen.days);
  // Consent binds both selectors as well as exact dates and the owner's timezone.
  return { start, end, timezone: zone, key: `${start}/${end}/${zone}/${chosen.days}/${chosen.topic}` };
}
function owner(userId) {
  const user = getDb().prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) throw fail('SESSION_INVALID', 401);
  return user;
}
function serialize(row, now = Date.now()) {
  if (!row) return null;
  const stale = row.status === 'processing' && (row.deadline_at <= now || row.started_at + 65000 <= now);
  return { id: row.id, status: stale ? 'uncertain' : row.status,
    text: row.status === 'ready' ? row.text : null, locale: row.locale,
    topic:row.topic, days:row.days, selection:{days:row.days,topic:row.topic},
    createdAt: new Date(row.created_at).toISOString(),
    errorCode: row.status === 'deleted' ? 'SUMMARY_DELETED' : stale ? 'PROVIDER_UNCERTAIN' : row.error_code,
    period: { start: row.period_start, end: row.period_end, timezone: row.timezone, key: row.period_key } };
}
function latest(db, userId) {
  return db.prepare('SELECT * FROM ai_weekly_summaries WHERE user_id=? ORDER BY started_at DESC,id DESC LIMIT 1').get(userId);
}
function quota(db, userId, now) {
  const row = latest(db,userId);
  if (!row) return {allowed:true,lastRequestedAt:null,nextAvailableAt:null};
  const next = row.started_at + QUOTA_MS;
  const active = db.prepare("SELECT 1 FROM ai_weekly_summaries WHERE user_id=? AND status='processing' AND deadline_at>? AND started_at>? LIMIT 1").get(userId,now,now-65000);
  return {allowed:now >= next && !active,lastRequestedAt:new Date(row.started_at).toISOString(),nextAvailableAt:new Date(next).toISOString()};
}
function read(userId, now = new Date(), input = {}) {
  const chosen = selection(input), db = getDb(), user = owner(userId), period = completedPeriod(user.timezone, now,chosen.days,chosen.topic);
  const empty = !db.prepare(`SELECT 1 FROM entries WHERE user_id=? AND entry_date BETWEEN ? AND ? AND type IN (${TYPES_SQL}) LIMIT 1`).get(userId,period.start,period.end,...ENTRY_TYPES);
  return { period, selection:chosen, topics:prompts.topics(normalizeLocale(user.locale)), quota:quota(db,userId,now.getTime()), empty,
    consentVersion: CONSENT_VERSION, paidMode: config.aiWeeklyPaidEnabled === true, available: provider.available(), provider: 'OpenRouter', model: config.aiWeeklyModel,
    summary: serialize(latest(db,userId), now.getTime()),
    archive: db.prepare("SELECT * FROM ai_weekly_summaries WHERE user_id=? AND status='ready' ORDER BY created_at DESC,id DESC").all(userId).map(row => serialize(row, now.getTime())) };
}
async function create(userId, input, stillAuthorized = () => true) {
  const db = getDb();
  const claim = db.transaction(() => {
    const user = owner(userId), chosen = selection(input || {},true), now = Date.now();
    const period = completedPeriod(user.timezone,new Date(now),chosen.days,chosen.topic);
    if (!stillAuthorized()) throw fail('SESSION_INVALID', 401);
    if (!input || input.consent !== true || input.consentVersion !== CONSENT_VERSION || input.periodKey !== period.key) throw fail('CONSENT_OR_PERIOD_INVALID');
    const prior = db.prepare(`SELECT * FROM ai_weekly_summaries WHERE user_id=? AND period_key=? AND days=? AND topic=? ORDER BY started_at DESC,id DESC LIMIT 1`).get(userId,period.key,chosen.days,chosen.topic);
    if (prior) return {run:false,chosen,row:prior};
    if (!quota(db,userId,now).allowed) throw fail('AI_QUOTA_EXCEEDED',429);
    const locale = normalizeLocale(user.locale);
    // Sentinel detects overflow; no silently truncated input or fake empty AI result.
    const entries = db.prepare(`SELECT entry_date,type,note FROM entries WHERE user_id=? AND entry_date BETWEEN ? AND ?
      AND type IN (${TYPES_SQL}) ORDER BY entry_date,id LIMIT 201`).all(userId,period.start,period.end,...ENTRY_TYPES);
    const records = entries.map(entry => ({ date: entry.entry_date, type: entry.type, title: entryTitle(entry.type,locale), note: entry.note || '' }));
    const context = {period,selection:chosen};
    const userPayload = prompts.messages(records,locale,context)[1].content;
    if (entries.length > 200 || Buffer.byteLength(userPayload,'utf8') > 24000) throw fail('INPUT_TOO_LARGE');
    if (!records.length) return {run:false,chosen};
    if (!provider.available()) throw fail('AI_UNAVAILABLE', 503);
    const rowId = db.prepare(`INSERT INTO ai_weekly_summaries
      (user_id,period_start,period_end,timezone,period_key,locale,status,model,consent_version,consent_at,started_at,deadline_at,created_at,topic,days,generation_version)
      VALUES(?,?,?,?,?,?,'processing',?,?,?,?,?,?,?,?,'2')`).run(userId,period.start,period.end,period.timezone,period.key,locale,config.aiWeeklyModel,CONSENT_VERSION,now,now,now+provider.timeoutMs()+2000,now,chosen.topic,chosen.days).lastInsertRowid;
    return { row: db.prepare('SELECT * FROM ai_weekly_summaries WHERE id=?').get(rowId), run: true, records, context, chosen };
  }).immediate();
  if (!claim.run) {
    const result = read(userId,new Date(),claim.chosen);
    if (claim.row) result.summary = serialize(claim.row);
    return result;
  }
  const row = claim.row;
  const active = () => stillAuthorized() && Boolean(db.prepare("SELECT 1 FROM ai_weekly_summaries WHERE id=? AND user_id=? AND status='processing'").get(row.id,userId));
  try {
    const text = await provider.generate(claim.records,row.locale,row.model,active,claim.context);
    if (active()) db.prepare("UPDATE ai_weekly_summaries SET status='ready',text=?,error_code=NULL WHERE id=? AND user_id=? AND status='processing'").run(text,row.id,userId);
    else db.prepare("UPDATE ai_weekly_summaries SET status='uncertain',error_code='REQUEST_CANCELLED' WHERE id=? AND user_id=? AND status='processing'").run(row.id,userId);
  } catch (error) {
    // Persist only an allowlisted code, never the provider exception or response.
    const codes = new Set(['FREE_MODEL_REQUIRED','PRICE_LIMIT_EXCEEDED','PRIVATE_ENDPOINT_UNAVAILABLE','AI_UNAVAILABLE','MODEL_VERIFICATION_FAILED','REQUEST_CANCELLED','PROVIDER_REJECTED','PROVIDER_UNCERTAIN','PROVIDER_RESPONSE_INVALID']);
    const code = codes.has(error.safeCode) ? error.safeCode : 'PROVIDER_UNCERTAIN';
    db.prepare("UPDATE ai_weekly_summaries SET status=?,error_code=? WHERE id=? AND user_id=? AND status='processing'").run(error.uncertain || !codes.has(error.safeCode) ? 'uncertain' : 'failed',code,row.id,userId);
  }
  if (!stillAuthorized()) throw fail('SESSION_INVALID',401);
  return read(userId,new Date(),claim.chosen);
}
function remove(userId, rawId) {
  owner(userId);
  if (!/^[1-9]\d*$/.test(String(rawId)) || !Number.isSafeInteger(Number(rawId))) throw fail('SUMMARY_NOT_FOUND',404);
  const result = getDb().prepare("UPDATE ai_weekly_summaries SET status='deleted',text=NULL,error_code=NULL,deleted_at=? WHERE id=? AND user_id=?").run(Date.now(),Number(rawId),userId);
  if (!result.changes) throw fail('SUMMARY_NOT_FOUND',404);
  return { deleted: true };
}
module.exports = { read, create, remove, completedPeriod, CONSENT_VERSION };
