const { getDb } = require('../db');

function loginIdentityStatus(userId) {
  const rows = getDb().prepare('SELECT provider FROM login_identities WHERE user_id = ?').all(userId);
  return { email: rows.some(row => row.provider === 'email'), google: rows.some(row => row.provider === 'google') };
}

// Gmail-backed Google login can recreate the email identity (and vice versa), so
// these two login methods must be detached together. Never delete the user/data.
function unlinkLoginIdentities(userId) {
  const db = getDb();
  return db.transaction(() => {
    const user = db.prepare('SELECT telegram_id, vk_id FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('Аккаунт не найден.');
    const telegram = String(user.telegram_id || '');
    const hasIndependentLogin = Boolean(user.vk_id) || /^\d+$/.test(telegram);
    if (!hasIndependentLogin) throw new Error('Сначала привяжи VK или Telegram, чтобы сохранить доступ к аккаунту.');
    const subjects = db.prepare("SELECT subject FROM login_identities WHERE user_id = ? AND provider = 'email'").all(userId);
    for (const { subject } of subjects) {
      db.prepare('DELETE FROM email_login_codes WHERE email = ? OR email = ?').run(subject, subject.replace(/@gmail\.com$/, '@googlemail.com'));
    }
    db.prepare('DELETE FROM email_login_codes WHERE requested_by = ?').run(userId);
    db.prepare('DELETE FROM google_oauth_states WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM google_oauth_intents WHERE user_id = ?').run(userId);
    const removed = db.prepare("DELETE FROM login_identities WHERE user_id = ? AND provider IN ('email','google')").run(userId).changes;
    return { removed, email: false, google: false };
  })();
}
module.exports = { loginIdentityStatus, unlinkLoginIdentities };
