// Isolated browser QA only: prevent dotenv from reading the working .env and
// reject all server outbound requests. The canonical runner supplies a temp DB.
if (!process.argv[1]?.endsWith('/src/server.js')) return; // Leave Playwright's own driver alone.
if (process.env.NODE_ENV !== 'test' || process.env.SCHEDULER_ENABLED !== 'false') throw Error('isolated QA required');
require('dotenv').config = () => ({});
global.fetch = () => Promise.reject(Error('QA outbound prohibited'));
for (const name of ['http', 'https']) {
  const module = require(name);
  module.request = module.get = () => { throw Error('QA outbound prohibited'); };
}
