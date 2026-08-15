function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeTimeZone(timeZone, fallback = 'Asia/Novosibirsk') {
  return isValidTimeZone(timeZone) ? timeZone : fallback;
}

function normalizeHHMM(value, fallback = '20:00') {
  const text = String(value || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function partsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const values = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function localDateInTimeZone(date = new Date(), timeZone = 'UTC') {
  const parts = partsInTimeZone(date, normalizeTimeZone(timeZone, 'UTC'));
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function offsetMinutesAt(utcDate, timeZone) {
  const parts = partsInTimeZone(utcDate, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - utcDate.getTime()) / 60000);
}

function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMinutesAt(new Date(utcMs), timeZone);
    const next = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset * 60000;
    if (Math.abs(next - utcMs) < 1000) break;
    utcMs = next;
  }
  return new Date(utcMs);
}

function addDaysToLocalDate({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function nextLocalTimeUtc(timeHHMM = '20:00', timeZone = 'UTC', now = new Date()) {
  const zone = normalizeTimeZone(timeZone, 'UTC');
  const [hour, minute] = normalizeHHMM(timeHHMM).split(':').map(Number);
  const localNow = partsInTimeZone(now, zone);
  let due = zonedTimeToUtc(localNow.year, localNow.month, localNow.day, hour, minute, zone);
  if (due <= now) {
    const tomorrow = addDaysToLocalDate(localNow, 1);
    due = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, zone);
  }
  return due;
}

function weekRangeForTimeZone(timeZone = 'UTC', now = new Date()) {
  const zone = normalizeTimeZone(timeZone, 'UTC');
  const parts = partsInTimeZone(now, zone);
  const middayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  const day = middayUtc.getUTCDay() || 7;
  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - day + 1, 12, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6, 12, 0, 0));
  return { weekStart: start.toISOString().slice(0, 10), weekEnd: end.toISOString().slice(0, 10) };
}

module.exports = { isValidTimeZone, normalizeTimeZone, normalizeHHMM, localDateInTimeZone, nextLocalTimeUtc, weekRangeForTimeZone };
