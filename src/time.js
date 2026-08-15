function normalizeTimezone(timezone) {
  const value = String(timezone || 'Asia/Novosibirsk').trim() || 'Asia/Novosibirsk';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch (_) {
    return 'UTC';
  }
}

function normalizeHHMM(value, fallback = '20:00') {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function localParts(date = new Date(), timezone = 'UTC') {
  const timeZone = normalizeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

function localDateString(date = new Date(), timezone = 'UTC') {
  const p = localParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function timezoneOffsetMs(date, timezone) {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0);
  return asUtc - date.getTime();
}

function zonedTimeToUtc(year, month, day, hour, minute, timezone) {
  // First guess treats the local wall-clock as UTC; then correct by the zone offset.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let date = new Date(utcMs - timezoneOffsetMs(new Date(utcMs), timezone));
  // Re-run once to handle DST/offset boundary around the guessed instant.
  date = new Date(utcMs - timezoneOffsetMs(date, timezone));
  return date;
}

function addDaysLocalDate(year, month, day, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function nextDueAt(timeHHMM = '20:00', timezone = 'UTC', now = new Date()) {
  const time = normalizeHHMM(timeHHMM);
  const [hour, minute] = time.split(':').map(Number);
  const local = localParts(now, timezone);
  let due = zonedTimeToUtc(local.year, local.month, local.day, hour, minute, timezone);
  if (due <= now) {
    const next = addDaysLocalDate(local.year, local.month, local.day, 1);
    due = zonedTimeToUtc(next.year, next.month, next.day, hour, minute, timezone);
  }
  return due.toISOString();
}

function weekStartDateString(date = new Date(), timezone = 'UTC') {
  const local = localParts(date, timezone);
  const noon = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
  const day = noon.getUTCDay() || 7;
  noon.setUTCDate(noon.getUTCDate() - day + 1);
  return noon.toISOString().slice(0, 10);
}

module.exports = { normalizeTimezone, normalizeHHMM, localDateString, nextDueAt, weekStartDateString };
