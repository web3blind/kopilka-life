const config = require('../config');

function sanitizeVkFirstName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\p{Cc}\p{Cf}<>]/gu, '').replace(/\s+/gu, ' ').trim()).slice(0, 60).join('');
}

// Optional enrichment only: the caller must obtain vkId from verified auth, never client profile data.
async function getVkFirstName(vkId) {
  const id = String(vkId || '');
  if (!config.vkGroupToken || !/^[1-9]\d{0,19}$/.test(id)) return '';
  try {
    const res = await fetch('https://api.vk.com/method/users.get', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ v: '5.199', access_token: config.vkGroupToken, user_ids: id }),
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (data?.error || !Array.isArray(data?.response) || data.response.length !== 1) return '';
    const profile = data.response[0];
    if (!profile || String(profile.id) !== id) return '';
    return sanitizeVkFirstName(profile.first_name);
  } catch (_) {
    // Unavailable/invalid profiles must not reject login or leak provider credentials/errors.
    return '';
  }
}

module.exports = { getVkFirstName, sanitizeVkFirstName };
