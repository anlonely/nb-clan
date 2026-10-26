import { existsSync } from 'node:fs';

/** Local mode is an explicit loopback-only runtime, never a public HTTP deployment. */
export function assertLocalMode(env = process.env) {
  if (env.NB_LOCAL_MODE !== '1') return false;
  let origin;
  try { origin = new URL(env.NB_V2_PUBLIC_ORIGIN || env.NB_PUBLIC_BASE_URL); } catch { throw new Error('LOCAL_ORIGIN_REQUIRED'); }
  const container = env.NB_LOCAL_CONTAINER === '1' && process.platform === 'linux' &&
    (existsSync('/.dockerenv') || existsSync('/run/.containerenv'));
  if (env.NB_LOCAL_CONTAINER === '1' && !container) throw new Error('LOCAL_CONTAINER_REQUIRED');
  if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.protocol !== 'http:' ||
      !(container ? ['0.0.0.0', '127.0.0.1'] : ['127.0.0.1', 'localhost']).includes(env.NB_BIND_HOST || '127.0.0.1') ||
      !['', '0', 'false', 'off', 'no'].includes(env.NB_TRUST_PROXY || '')) throw new Error('LOCAL_LOOPBACK_REQUIRED');
  return true;
}
