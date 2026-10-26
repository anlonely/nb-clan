import './support/owner-environment.mjs';
import './support/v2-baseline/loopback-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './support/v2-source-admin/fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';
async function setup(t) {
  const f = await httpFixture(); t.after(() => f.close());
  const request = async (s, route = '', { action, input, id = randomUUID(), csrf = true, origin = f.origin, raw, recover = false } = {}) => {
    const mutation = Boolean(action || recover), res = await fetch(f.origin + '/api/v2/source-admin' + (action ? '/commands/' + action : route), {
      method: mutation ? 'POST' : 'GET', headers: { ...(s ? { Cookie: `nb_v2_session=${s.token}` } : {}), ...(mutation ? { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': id, ...(csrf ? { 'X-CSRF-Token': s?.csrfToken || '' } : {}) } : {}) }, ...(mutation ? { body: raw ?? JSON.stringify({ input }) } : {}) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { ...f, request };
}
test('real G03 Cookie/CSRF/exact-origin guard protects writes and ordinary GET has no SQLite changes', async t => {
  const f = await setup(t), s = f.session('root');
  assert.equal((await f.request(null)).status, 401);
  const count = f.db.prepare('SELECT total_changes() n').get().n;
  const read = await f.request(s); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, count);
  const input = { expectedRevision: f.revision('steam'), apiKey: 'synthetic-http-steam-key' };
  assert.equal((await f.request(s, '', { action: 'steam.save', input, csrf: false })).status, 403);
  assert.equal((await f.request(s, '', { action: 'steam.save', input, origin: 'http://localhost.evil' })).status, 403);
  const ok = await f.request(s, '', { action: 'steam.save', input }); assert.equal(ok.status, 200); assert.equal(ok.body.data.cacheState, 'refreshed');
});
test('only current owner writes; explicit admin reads and a role impostor is denied', async t => {
  const f = await setup(t), input = { expectedRevision: f.revision('steam'), apiKey: 'synthetic-http-steam-key' };
  const admin = f.session('admin');
  assert.equal((await f.request(admin)).body.data.items[0].canWrite, false);
  assert.equal((await f.request(admin, '', { action: 'steam.save', input })).status, 403);
  assert.equal((await f.request(f.session('impostor'))).status, 403);
  const root = f.session('root');
  for (const binding of f.repo.all('bindings').filter(row => row.accountId === 'root')) f.repo.put('bindings', { ...binding, status: 'legacy_unverified' });
  assert.equal((await f.request(root, '', { action: 'steam.save', input })).status, 401);
});
test('unknown fields, malformed JSON and oversized bodies never echo raw credentials', async t => {
  const f = await setup(t), s=f.session('root'), secret='synthetic-malformed-body-secret';
  for (const raw of [`{"input":{"apiKey":"${secret}",`, JSON.stringify({input:{expectedRevision:f.revision('steam'),apiKey:secret,role:'root'}}), JSON.stringify({input:{apiKey:secret.repeat(1000)}})]) {
    const r=await f.request(s,'',{action:'steam.save',raw}); assert.ok(r.status>=400); assert.ok(!JSON.stringify(r.body).includes(secret));
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_admin_operations').get().n,0);
});
test('HTTP concurrent observed revision and same-key replay preserve single commit', async t => {
  const f=await setup(t),s=f.session('root'),id=randomUUID(),input={expectedRevision:f.revision('steam'),apiKey:'synthetic-http-steam-key'};
  const [a,b]=await Promise.all([f.request(s,'',{action:'steam.save',input,id}),f.request(s,'',{action:'steam.save',input,id})]); assert.equal(a.status,200);assert.equal(b.status,200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_admin_audits').get().n,1);
  const conflict=await f.request(s,'',{action:'steam.save',input:{...input,apiKey:input.apiKey+'other'}});assert.equal(conflict.status,409);
});
test('HTTP cache failure returns safe uncertain result and POST recover repairs without plaintext resubmission', async t => {
  const f=await setup(t),s=f.session('root'),id=randomUUID(),secret='synthetic-cache-http-secret';
  f.hooks.beforeCache=()=>{throw Error(secret);};
  const first=await f.request(s,'',{action:'steam.save',input:{expectedRevision:f.revision('steam'),apiKey:secret},id});assert.equal(first.status,503);assert.ok(!JSON.stringify(first.body).includes(secret));
  const read=await f.request(s,'/operations/'+id);assert.equal(read.status,200);assert.equal(read.body.data.cacheState,'not_checked');
  assert.equal((await f.request(s,'/operations/'+id+'/recover',{recover:true,id,csrf:false})).status,403);
  f.hooks.beforeCache=null;const recovered=await f.request(s,'/operations/'+id+'/recover',{recover:true,id});assert.equal(recovered.status,200);assert.equal(recovered.body.data.cacheState,'refreshed');assert.equal(f.cache.settings.steamWebApi.apiKey,secret);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_source_admin_audits').get().n,1);
});
test('revoked G03 session cannot replay, recover or read receipt; fresh session still requires verified owner identity', async t => {
  const f=await setup(t),s=f.session('root'),id=randomUUID(),input={expectedRevision:f.revision('steam'),apiKey:'synthetic-http-steam-key'};
  assert.equal((await f.request(s,'',{action:'steam.save',input,id})).status,200);
  const a=f.repo.get('accounts','root');f.repo.put('accounts',{...a,permissionVersion:a.permissionVersion+1,grants:[]});
  for (const binding of f.repo.all('bindings').filter(row => row.accountId === 'root')) f.repo.put('bindings', { ...binding, status: 'legacy_unverified' });
  for (const result of [await f.request(s,'',{action:'steam.save',input,id}),await f.request(s,'/operations/'+id),await f.request(s,'/operations/'+id+'/recover',{recover:true,id})])assert.equal(result.status,401);
  assert.equal((await f.request(f.session('root'),'/operations/'+id)).status,403);
});
