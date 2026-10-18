const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { sendLoginCode } = require('../src/services/emailSender');
test('Resend sender uses noreply without SMTP mailbox and directs replies to contact', async () => {
  const oldFetch = global.fetch, oldKey = config.resendApiKey;
  try {
    config.resendApiKey = 'fixture-api-key';
    global.fetch = async (url, opts) => {
      assert.equal(url, 'https://api.resend.com/emails');
      const payload = JSON.parse(opts.body);
      assert.equal(payload.from, 'noreply@blinddev.xyz');
      assert.equal(payload.reply_to, 'contact@blinddev.xyz');
      assert.deepEqual(payload.to, ['test@example.com']);
      assert.match(payload.text, /123456/);
      return new Response('{}', { status: 200 });
    };
    await sendLoginCode('test@example.com', '123456');
  } finally { config.resendApiKey = oldKey; global.fetch = oldFetch; }
});
