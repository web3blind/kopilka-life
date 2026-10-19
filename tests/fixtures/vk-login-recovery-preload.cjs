// Test-only provider stand-in. All real API/state/PKCE/browser-binding routes run.
if (!process.argv[1]?.endsWith('/src/server.js')) return;
if (process.env.NODE_ENV !== 'test' || process.env.SCHEDULER_ENABLED !== 'false') throw Error('isolated QA required');
require('dotenv').config = () => ({});
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  const target = new URL(String(url));
  if (String(url) === process.env.VK_OAUTH_TOKEN_URL && target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname)) return realFetch(url, options);
  if (String(url) !== 'https://qa-vk.invalid/token') throw Error('QA outbound prohibited');
  const body = new URLSearchParams(String(options.body));
  if (body.get('code') !== 'fixture-code' || body.get('device_id') !== 'fixture-device' || !/^[A-Za-z0-9_-]{64}$/.test(body.get('code_verifier') || '')) throw Error('invalid fixture exchange');
  return new Response(JSON.stringify({user_id:'92003',access_token:'test-only-not-used'}), {status:200});
};
for (const name of ['http','https']) {
  const module = require(name);
  module.request = module.get = () => { throw Error('QA outbound prohibited'); };
}
