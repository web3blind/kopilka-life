'use strict';
// Test-only: no provider transport is permitted in the localization suite.
const deny = () => { throw new Error('Localization QA denied outbound transport'); };
for (const name of ['node:http', 'node:https']) {
  const mod = require(name);
  for (const method of ['request', 'get']) {
    const original = mod[method];
    mod[method] = function (input, ...args) {
      const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host;
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return deny();
      return original.call(this, input, ...args);
    };
  }
}
const originalFetch = global.fetch;
global.fetch = function (input, ...args) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(input.url || input).hostname)) return deny();
  return originalFetch.call(this, input, ...args);
};
