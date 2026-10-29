// Local isolated acceptance fixture only. Never preload in production.
if (process.env.NODE_ENV !== 'test' || process.env.TURNSTILE_SECRET_KEY !== 'fixture-secret') throw new Error('QA only');
global.fetch = async (url, options) => {
  if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected outbound QA request');
  const body=JSON.parse(options.body);
  return Response.json({ success:body.response==='fixture-ok', action:'partner_inquiry', hostname:'127.0.0.1', challenge_ts:new Date().toISOString() });
};
