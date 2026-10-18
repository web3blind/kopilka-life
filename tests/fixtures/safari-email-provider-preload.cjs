// EMAIL DELIVERY ONLY. Never preload in production or replace auth/OTP/Google.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sink = process.env.KOPILKA_SAFARI_QA_CODES;
const cwd = fs.realpathSync(process.cwd());
if (process.env.NODE_ENV !== 'test' || !sink || path.dirname(sink) !== cwd ||
    path.dirname(process.env.DB_PATH || '') !== cwd || fs.existsSync(path.join(cwd, '.env')) ||
    process.env.SCHEDULER_ENABLED !== 'false' || process.env.DEV_AUTH_ENABLED !== 'false' ||
    process.env.RESEND_API_KEY !== 'fixture-only' ||
    ['BOT_TOKEN', 'VK_GROUP_TOKEN', 'VK_SECURE_KEY', 'VK_OAUTH_CLIENT_SECRET',
     'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'VAPID_PRIVATE_KEY'].some(key => process.env[key])) {
  throw new Error('Safari email fixture requires disposable test isolation');
}
global.fetch = async (url, options) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error('External fetch prohibited in Safari email QA');
  const payload = JSON.parse(options.body);
  const email = String(payload.to?.[0] || '');
  const code = String(payload.text || '').match(/\b\d{6}\b/)?.[0];
  if (payload.to.length !== 1 || !/^[a-z0-9-]+@safari-qa\.test$/.test(email) || !code ||
      payload.from !== 'sender@safari-qa.test' || payload.reply_to !== 'reply@safari-qa.test') {
    throw new Error('Safari email sink accepts fictional QA addresses only');
  }
  fs.writeFileSync(sink, JSON.stringify({ email, code }), { mode: 0o600 });
  fs.chmodSync(sink, 0o600);
  return new Response(JSON.stringify({ id: 'safari-email-fixture-only' }), { status: 200 });
};
