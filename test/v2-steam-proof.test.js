import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyKookSteamIdentity } from '../server/kook-steam-openid.js';

function assertion() {
  return { 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.return_to': 'https://local.test/api/v2/auth/steam/callback?state=one',
    'openid.response_nonce': '2026-09-08T00:00:00Znonce',
    'openid.assoc_handle': 'fixture', 'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': 'proof' };
}
test('shared Steam verifier calls provider verification and checks signed endpoint, identity, return_to and freshness', async () => {
  const q = assertion(); let calls = 0;
  const options = { now: () => Date.parse('2026-09-08T00:00:10Z'), fetch: async (url, input) => {
    calls++; assert.equal(url, 'https://steamcommunity.com/openid/login'); assert.equal(input.redirect, 'error');
    assert.equal(new URLSearchParams(input.body).get('openid.mode'), 'check_authentication');
    return { ok: true, text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' };
  } };
  assert.equal(await verifyKookSteamIdentity(q, q['openid.return_to'], options), '76561198000000001'); assert.equal(calls, 1);
  for (const change of [{ 'openid.return_to': 'https://attacker.test' }, { 'openid.identity': '76561198000000001' },
    { 'openid.op_endpoint': 'https://attacker.test' }, { 'openid.signed': 'identity,claimed_id' },
    { 'openid.response_nonce': '2026-01-01T00:00:00Zold' }, { 'openid.claimed_id': ['ambiguous'] }, { 'openid.mode': 'cancel' }]) {
    await assert.rejects(() => verifyKookSteamIdentity({ ...q, ...change }, q['openid.return_to'], options));
  }
  assert.equal(calls, 1);
  await assert.rejects(() => verifyKookSteamIdentity(q, q['openid.return_to'], { ...options, fetch: async () => ({ ok: true, text: async () => 'is_valid:false' }) }));
});

test('Steam verifier distinguishes platform overload and transport failure from a bad assertion', async () => {
  const q = assertion(), now = () => Date.parse('2026-09-08T00:00:10Z');
  await assert.rejects(() => verifyKookSteamIdentity(q, q['openid.return_to'], { now,
    fetch: async () => ({ ok: false, status: 429, headers: { get: () => '18' } }) }),
  { errorKey: 'steamRateLimited', retryAfterSeconds: 18 });
  await assert.rejects(() => verifyKookSteamIdentity(q, q['openid.return_to'], { now,
    fetch: async () => { throw Error('network down'); } }), { errorKey: 'steamUnavailable' });
});
