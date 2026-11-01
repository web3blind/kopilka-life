'use strict';
// Opt-in fixture preload for ai-result-actions-browser-qa.py only.
if (process.env.NODE_ENV !== 'test' || !process.env.DB_PATH?.endsWith('qa.sqlite')) {
  throw new Error('Result-actions preload requires the isolated browser runner');
}
process.env.AI_WEEKLY_ENABLED = 'true';
process.env.AI_WEEKLY_GEMINI_API_KEY = 'fixture-only-never-dispatched';
process.env.AI_WEEKLY_OPENROUTER_API_KEY = '';
process.env.AI_WEEKLY_PAID_ENABLED = 'false';
global.fetch = async () => { throw new Error('Provider fetch prohibited in result-only QA'); };
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function (...args) {
      const first = args[0];
      const host = typeof first === 'string' || first instanceof URL
        ? new URL(first).hostname : first.hostname || first.host;
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Outbound HTTP prohibited');
      return original.apply(this, args);
    };
  }
}
