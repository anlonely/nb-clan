import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { nowIso } from './store.js';

function envNonNegativeInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, max);
}

const API_SLOW_REQUEST_MS = envNonNegativeInteger(process.env.NB_API_SLOW_REQUEST_MS, 500, 60_000);
const API_RECENT_LIMIT = 80;
const apiMetrics = {
  total: 0,
  slow: 0,
  errors5xx: 0,
  totalMs: 0,
  maxMs: 0,
  totalBytes: 0,
  maxBytes: 0,
  last: null,
  byRoute: {},
  recentSlow: [],
  recent5xx: []
};

function apiRouteKey(req) {
  const routePath = req.route?.path;
  const baseUrl = req.baseUrl || '';
  if (routePath) return `${baseUrl}${Array.isArray(routePath) ? routePath.join('|') : routePath}`;
  return String(req.originalUrl || req.url || '').split('?')[0] || 'unknown';
}

function pushRecentMetric(list, item) {
  list.unshift(item);
  if (list.length > API_RECENT_LIMIT) list.length = API_RECENT_LIMIT;
}

function recordApiRequestMetric(metric) {
  const key = `${metric.method} ${metric.route}`;
  apiMetrics.total += 1;
  apiMetrics.totalMs += metric.durationMs;
  apiMetrics.maxMs = Math.max(apiMetrics.maxMs, metric.durationMs);
  apiMetrics.totalBytes += metric.responseBytes;
  apiMetrics.maxBytes = Math.max(apiMetrics.maxBytes, metric.responseBytes);
  if (metric.durationMs >= API_SLOW_REQUEST_MS) {
    apiMetrics.slow += 1;
    pushRecentMetric(apiMetrics.recentSlow, metric);
  }
  if (metric.status >= 500) {
    apiMetrics.errors5xx += 1;
    pushRecentMetric(apiMetrics.recent5xx, metric);
  }
  apiMetrics.byRoute[key] ||= {
    method: metric.method,
    route: metric.route,
    total: 0,
    slow: 0,
    errors5xx: 0,
    totalMs: 0,
    maxMs: 0,
    totalBytes: 0,
    maxBytes: 0,
    last: null
  };
  const route = apiMetrics.byRoute[key];
  route.total += 1;
  route.totalMs += metric.durationMs;
  route.maxMs = Math.max(route.maxMs, metric.durationMs);
  route.totalBytes += metric.responseBytes;
  route.maxBytes = Math.max(route.maxBytes, metric.responseBytes);
  if (metric.durationMs >= API_SLOW_REQUEST_MS) route.slow += 1;
  if (metric.status >= 500) route.errors5xx += 1;
  route.last = metric;
  apiMetrics.last = metric;
}

export function publicApiRuntimeMetrics() {
  const routes = Object.values(apiMetrics.byRoute)
    .map((route) => ({
      method: route.method,
      route: route.route,
      total: route.total,
      slow: route.slow,
      errors5xx: route.errors5xx,
      avgMs: route.total ? Number((route.totalMs / route.total).toFixed(3)) : 0,
      maxMs: Number(route.maxMs.toFixed(3)),
      avgBytes: route.total ? Math.round(route.totalBytes / route.total) : 0,
      maxBytes: route.maxBytes,
      last: route.last
    }))
    .sort((left, right) => right.maxMs - left.maxMs)
    .slice(0, 30);
  return {
    slowThresholdMs: API_SLOW_REQUEST_MS,
    total: apiMetrics.total,
    slow: apiMetrics.slow,
    errors5xx: apiMetrics.errors5xx,
    avgMs: apiMetrics.total ? Number((apiMetrics.totalMs / apiMetrics.total).toFixed(3)) : 0,
    maxMs: Number(apiMetrics.maxMs.toFixed(3)),
    avgBytes: apiMetrics.total ? Math.round(apiMetrics.totalBytes / apiMetrics.total) : 0,
    maxBytes: apiMetrics.maxBytes,
    last: apiMetrics.last,
    routes,
    recentSlow: apiMetrics.recentSlow,
    recent5xx: apiMetrics.recent5xx
  };
}

export function observeApiRequest(req, res, next) {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.setHeader('X-Request-Id', requestId);
  res.write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    if (typeof chunk === 'function') return originalEnd(chunk);
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);
    return originalEnd(chunk, encoding, callback);
  };
  res.on('finish', () => {
    recordApiRequestMetric({
      requestId,
      method: req.method,
      route: apiRouteKey(req),
      status: res.statusCode,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      responseBytes,
      at: nowIso()
    });
  });
  next();
}
