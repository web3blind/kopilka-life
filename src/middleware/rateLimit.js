function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs || 60000));
  const max = Math.max(1, Number(options.max || 60));
  const keyPrefix = options.keyPrefix || 'rl';
  const keyFn = options.keyFn || ((req) => clientIp(req));
  const store = new Map();

  function cleanup(now) {
    for (const [key, bucket] of store.entries()) {
      if (bucket.resetAt <= now) store.delete(key);
    }
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    if (store.size > 10000) cleanup(now);
    const key = `${keyPrefix}:${keyFn(req)}`;
    const bucket = store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Слишком много запросов. Попробуй чуть позже.' });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
