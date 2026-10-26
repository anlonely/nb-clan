import { getIp } from './request-context.js';

const buckets = new Map();
const DEFAULT_MAX_BUCKETS = 10_000;

function maxBucketCount() {
  const configured = Number(process.env.NB_RATE_LIMIT_MAX_BUCKETS || DEFAULT_MAX_BUCKETS);
  return Number.isFinite(configured)
    ? Math.max(100, Math.min(100_000, Math.floor(configured)))
    : DEFAULT_MAX_BUCKETS;
}

function pruneBuckets(now = Date.now()) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  const maximum = maxBucketCount();
  while (buckets.size >= maximum) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
}

export function rateLimit({ windowMs, max, name, key, onLimit }) {
  return (req, res, next) => {
    let subject = '';
    try {
      subject = typeof key === 'function' ? key(req) : '';
    } catch (_error) {
      subject = '';
    }
    const bucketKey = `${name}:${String(subject || getIp(req)).trim() || 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxBucketCount()) pruneBuckets(now);
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      if (onLimit) return onLimit(req, res, retryAfter);
      res.status(429).json({ ok: false, error: '请求过于频繁，请稍后再试' });
      return;
    }

    next();
  };
}

export const __rateLimitForTests = {
  reset() {
    buckets.clear();
  },
  size() {
    return buckets.size;
  },
  prune(now = Date.now()) {
    pruneBuckets(now);
  }
};
