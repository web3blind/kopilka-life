// Server-side text sanitation for user-provided fields.
// Goal: neutralize HTML/JS injection payloads and URL/spam patterns so stored
// text renders as harmless plain text. Client-side escaping (escapeHtml) already
// prevents XSS at render; this is defense-in-depth at write time.

// Matches URL-like patterns: scheme, www., t.me/telegram.me, domain.tld, bare @mentions.
const URL_PATTERN = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|\b[a-z0-9-]+\.(?:com|net|org|ru|io|xyz|dev|app|site|info|biz|club|online|top|store|me)\b|\B@[a-zA-Z0-9_]{3,})/gi;
// Control characters except newline/tab (strip NUL and friends).
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Any HTML/XML-ish tag, including script/style and attribute handlers.
const TAG_PATTERN = /<\/?[a-z][^>]*>/gi;

function stripControlChars(value) {
  return String(value || '').replace(CONTROL_PATTERN, '');
}

// Neutralize obvious markup so stored text cannot carry tags or event handlers.
function neutralizeTags(value) {
  return String(value || '').replace(TAG_PATTERN, ' ');
}

// Replace URL-like tokens with a neutral placeholder so text cannot smuggle
// clickable/scriptable links (spam, ads, phishing).
function neutralizeUrls(value) {
  return String(value || '').replace(URL_PATTERN, '[ссылка скрыта]');
}

// Full sanitation applied at write time to user-provided free text.
function sanitizeText(value, { maxLength = 500, neutralizeLinks = true } = {}) {
  let out = stripControlChars(value);
  if (neutralizeLinks) out = neutralizeUrls(out);
  out = neutralizeTags(out);
  out = out.trim();
  if (maxLength) out = out.slice(0, maxLength);
  return out;
}

module.exports = { sanitizeText, stripControlChars, neutralizeUrls, neutralizeTags, URL_PATTERN };
