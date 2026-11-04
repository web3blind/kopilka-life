'use strict';
// Test-only transport fence; never preload in production.
const fs = require('node:fs');
function allowed(input) {
  const host = typeof input === 'string' || input instanceof URL
    ? new URL(input).hostname : input.hostname || input.host;
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return;
  if (process.env.NOTICES_QA_OUTBOUND_LOG) fs.appendFileSync(process.env.NOTICES_QA_OUTBOUND_LOG, 'blocked\n');
  throw new Error('Notices QA denied outbound transport');
}
for (const name of ['node:http', 'node:https']) {
  const mod = require(name);
  for (const method of ['request', 'get']) {
    const original = mod[method];
    mod[method] = function (input, ...args) { allowed(input); return original.call(this, input, ...args); };
  }
}
const originalFetch = global.fetch;
global.fetch = function (input, ...args) { allowed(input.url || input); return originalFetch.call(this, input, ...args); };
