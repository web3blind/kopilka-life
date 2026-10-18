// Test server only: replace outbound email delivery and Google token verifier.
// All app routes, OAuth state/browser binding, OTP hash checks and merge paths run unchanged.
if (process.env.NODE_ENV !== 'test' || !process.env.KOPILKA_LINK_QA_CODES) throw new Error('link fixture requires test isolation');
const fs = require('node:fs');
const { OAuth2Client } = require('google-auth-library');
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url) === 'https://api.resend.com/emails') {
    const payload = JSON.parse(options.body);
    const email = String(payload.to?.[0] || '');
    const code = String(payload.text || '').match(/\b\d{6}\b/)?.[0];
    if (!email || !code) throw new Error('Unexpected fixture email payload');
    fs.writeFileSync(process.env.KOPILKA_LINK_QA_CODES, JSON.stringify({ email, code }), { mode: 0o600 });
    return new Response(JSON.stringify({ id: 'qa-only' }), { status: 200 });
  }
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(options.body));
    const code = JSON.parse(Buffer.from(body.get('code'), 'base64url').toString());
    if (!code.sub || !code.nonce || code.email_verified !== true) throw new Error('Unexpected fixture Google code');
    return new Response(JSON.stringify({ id_token: Buffer.from(JSON.stringify(code)).toString('base64url') }), { status: 200 });
  }
  throw new Error('External fetch prohibited in local link QA: ' + new URL(String(url)).origin);
};
OAuth2Client.prototype.verifyIdToken = async function ({ idToken, audience }) {
  if (audience !== process.env.GOOGLE_CLIENT_ID) throw new Error('Unexpected fixture audience');
  const payload = JSON.parse(Buffer.from(idToken, 'base64url').toString());
  return { getPayload: () => payload };
};
