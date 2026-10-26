import nodeFetch from 'node-fetch';
const PROVIDER = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';

export function kookSteamAuthorizationUrl(returnTo, origin) {
  const params = new URLSearchParams({ 'openid.ns': NS, 'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo, 'openid.realm': origin,
    'openid.identity': `${NS}/identifier_select`, 'openid.claimed_id': `${NS}/identifier_select` });
  return `${PROVIDER}?${params}`;
}

export async function verifyKookSteamIdentity(query, returnTo, { fetch = nodeFetch, now = Date.now } = {}) {
  const invalid = () => Object.assign(new Error('kookSteamVerifyFailed'), { errorKey: 'kookSteamVerifyFailed' });
  for (const value of Object.values(query)) if (typeof value !== 'string' || value.length > 4096) throw invalid();
  const claimed = query['openid.claimed_id'] || '';
  const steamId = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(7656\d{13})$/)?.[1];
  const signed = new Set(String(query['openid.signed'] || '').split(','));
  const nonceTime = Date.parse(String(query['openid.response_nonce'] || '').slice(0, 20));
  if (!steamId || query['openid.identity'] !== claimed || query['openid.ns'] !== NS ||
      query['openid.mode'] !== 'id_res' || query['openid.op_endpoint'] !== PROVIDER ||
      query['openid.return_to'] !== returnTo || !Number.isFinite(nonceTime) ||
      Math.abs(now() - nonceTime) > 10 * 60_000 ||
      !['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'].every((key) => signed.has(key))) {
    throw invalid();
  }
  const params = new URLSearchParams(Object.entries(query).filter(([key]) => key.startsWith('openid.')));
  params.set('openid.mode', 'check_authentication');
  let response;
  try {
    response = await fetch(PROVIDER, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString(), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw Object.assign(new Error('steamUnavailable'), { errorKey: 'steamUnavailable' });
  }
  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.('retry-after'));
    throw Object.assign(new Error('steamRateLimited'), { errorKey: 'steamRateLimited',
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(600, Math.ceil(seconds)) : 30 });
  }
  if (response.status >= 500) throw Object.assign(new Error('steamUnavailable'), { errorKey: 'steamUnavailable' });
  if (!response.ok) throw invalid();
  let proof;
  try { proof = await response.text(); }
  catch { throw Object.assign(new Error('steamUnavailable'), { errorKey: 'steamUnavailable' }); }
  if (!/^is_valid:true\r?$/m.test(proof)) throw invalid();
  return steamId;
}
