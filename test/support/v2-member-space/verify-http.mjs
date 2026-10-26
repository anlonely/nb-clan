import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { root } from './config.mjs';

const pointer = JSON.parse(await readFile(path.join(root, 'work/g05/runtime-latest.json')));
const runtime = JSON.parse(await readFile(pointer.metadata));
assert.ok(runtime.runDir.startsWith(path.join(root, 'work/g05/runtime-')));
assert.match(runtime.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const origin = runtime.origin, evidence = { startedAt: new Date().toISOString(), origin, runDir: runtime.runDir,
  scope: 'Real local business routers and SQLite; constructed external OAuth/roles/Steam', checks: [], passed: false };
const fresh = () => ({ jar: new Map(), csrf: null });
async function request(client, route, { method = 'GET', body, csrf = true, operationId, headers = {} } = {}) {
  const response = await fetch(`${origin}${route}`, { redirect: 'manual', method, headers: { origin,
    cookie: [...client.jar].map(([k,v]) => `${k}=${v}`).join('; '),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(csrf && client.csrf ? { 'x-csrf-token': client.csrf } : {}),
    ...(operationId ? { 'Idempotency-Key': operationId } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const line of response.headers.getSetCookie()) { const [k,v] = line.split(';')[0].split('='); v ? client.jar.set(k,v) : client.jar.delete(k); }
  return { status: response.status, location: response.headers.get('location'), cookies: response.headers.getSetCookie(),
    payload: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}
async function check(name, fn) { await fn(); evidence.checks.push({ name, passed: true }); }
async function login(key, returnTo = '/app/home') {
  const client = fresh(), start = await request(client, `/api/v2/auth/discord/start?${new URLSearchParams({ returnTo })}`);
  assert.equal(start.status, 302); assert.ok(start.cookies.some(cookie => cookie.includes('HttpOnly') && cookie.includes('Path=/api/v2')));
  const state = new URL(start.location).searchParams.get('state');
  const picker = await request(client, new URL(start.location).pathname + new URL(start.location).search);
  assert.equal(picker.status, 200); assert.match(picker.payload, /构造平台账号/);
  let reply = await request(client, `/api/v2/__fixtures/oauth/discord/select?${new URLSearchParams({ state, fixture: key })}`);
  for (let i = 0; i < 4 && reply.location?.startsWith(`${origin}/api/v2/auth/`); i++) {
    const url = new URL(reply.location); reply = await request(client, url.pathname + url.search);
  }
  client.landing = reply.location;
  const me = await request(client, '/api/v2/auth/me');
  if (me.status === 200) client.csrf = me.payload.data.csrfToken;
  return client;
}
async function control(body, authorized = true) {
  return request(fresh(), '/api/v2/__fixtures/control', { method: 'POST', body,
    headers: authorized ? { 'x-g05-control': runtime.controlToken } : {} });
}
try {
  await check('ready runtime has real identity and scheduling schema and migration markers', async () => {
    const r = await request(fresh(), '/api/v2/__fixtures/health'); assert.equal(r.status,200);
    assert.equal(r.payload.identitySchema,1); assert.equal(r.payload.schedulingSchema,1);
    assert.equal(r.payload.identityMigration,true); assert.equal(r.payload.schedulingMigration,true);
  });
  await check('member bootstrap, profile and team fail closed without a V2 session', async () => {
    for (const route of ['/bootstrap','/me','/me/home','/me/team']) assert.equal((await request(fresh(), `/api/v2${route}`)).status,401);
  });
  let beta;
  await check('constructed OAuth exchange follows real callback/finish and preserves a deep return URL', async () => {
    beta = await login('beta', `/app/wipes/${runtime.nextWipeId}`);
    assert.equal(beta.landing, `${origin}/app/wipes/${runtime.nextWipeId}`);
    const r = await request(beta, '/api/v2/bootstrap'); assert.equal(r.status,200);
    assert.equal(r.payload.data.accountId,'g05_account_beta'); assert.equal(r.payload.data.memberId,'g05_beta');
    assert.equal(r.payload.data.csrfToken,beta.csrf); assert.equal(r.payload.data.participation.canSignup,true);
  });
  await check('home chooses the next eligible time instead of the first ID cursor record', async () => {
    const home = await request(beta, '/api/v2/me/home'); assert.equal(home.status,200);
    assert.equal(home.payload.data.nextWipe.id,runtime.nextWipeId); assert.notEqual(runtime.nextWipeId,runtime.firstOwnIdCursorWipeId);
    assert.equal(JSON.stringify(home.payload).includes(runtime.foreignWipeId),false);
  });
  await check('my team and history use real authorized member routes', async () => {
    const team = await request(beta, '/api/v2/me/team'); assert.equal(team.status,200); assert.match(JSON.stringify(team.payload), /北境一队/);
    assert.equal(JSON.stringify(team.payload).includes('g05_foreign'),false);
    assert.equal((await request(beta, '/api/v2/me/history')).status,200);
  });
  await check('CSRF and immutable identity fields cannot be bypassed through profile writes', async () => {
    const me = await request(beta,'/api/v2/me'), revision = me.payload.data.profile.revision;
    const body = { expectedRevision:revision, displayName:'小林', steamId:'76561198000000599' };
    assert.equal((await request(beta,'/api/v2/me',{ method:'PATCH',body,operationId:randomUUID(),csrf:false })).status,403);
    const result = await request(beta,'/api/v2/me',{ method:'PATCH',body,operationId:randomUUID() });
    assert.equal(result.status,422); assert.equal(result.payload.error.errorCode,'INVALID_PROFILE');
  });
  await check('fixture controls require a separate local capability token', async () => assert.equal((await control({ action:'inspect' },false)).status,403));
  await check('first-time OAuth onboarding creates no account until real Steam confirmation, and cancellation is recoverable', async () => {
    const newbie = await login('new', `/app/wipes/${runtime.nextWipeId}`); assert.equal(newbie.csrf,null);
    let r = await request(newbie,'/api/v2/auth/continue'); assert.equal(r.status,200); assert.equal(r.payload.data.step,'steam');
    assert.equal(r.payload.data.returnTo,`/app/wipes/${runtime.nextWipeId}`); newbie.csrf = r.payload.data.csrfToken;
    r = await request(newbie,'/api/v2/auth/steam/start',{ method:'POST',body:{} }); assert.equal(r.status,200);
    const url = new URL(r.payload.data.authorizationUrl); r = await request(newbie,url.pathname+url.search);
    assert.equal(r.status,200); assert.match(r.payload,/data-fixture-steam="new"/);
    assert.equal((await request(newbie,'/api/v2/auth/cancel',{ method:'POST',body:{} })).status,200);
    assert.equal((await request(newbie,'/api/v2/auth/continue')).status,410);
    assert.equal((await request(newbie,'/api/v2/auth/me')).status,401);
  });
  await check('an OAuth identity lacking the constructed platform role remains denied', async () => {
    const denied = await login('denied'); const r = await request(denied,'/api/v2/auth/continue');
    assert.equal(r.status,200); assert.equal(r.payload.data.errorCode,'ELIGIBILITY_DENIED'); assert.equal((await request(denied,'/api/v2/bootstrap')).status,401);
  });
  await check('captain and administrator retain their own member participation', async () => {
    for (const key of ['leader','admin']) { const client = await login(key), r = await request(client,'/api/v2/bootstrap');
      assert.equal(r.status,200); assert.equal(r.payload.data.roleId,key); assert.equal(r.payload.data.participation.canSignup,true); }
  });
  await check('foreign member cannot see the first team wipe', async () => {
    const foreign = await login('foreign'); assert.equal((await request(foreign,`/api/v2/wipes/${runtime.nextWipeId}/summary`)).status,404);
    const r = await request(foreign,'/api/v2/me/home'); assert.equal(r.payload.data.nextWipe.id,runtime.foreignWipeId);
  });
  await check('lost committed response preserves the operation receipt and replays only the exact body/key', async () => {
    const route = `/api/v2/wipes/${runtime.nextWipeId}/my-signup`, prior = await request(beta,route);
    const wipe = await request(beta,`/api/v2/wipes/${runtime.nextWipeId}`), key = randomUUID();
    const body = { response:'attending_on_time',expectedArrivalAt:null,timeZone:'Asia/Shanghai',expectedSignupRevision:prior.payload.data.signupRevision,confirmedContentRevision:wipe.payload.data.contentRevision };
    assert.equal((await control({ action:'fault',fixture:'beta',method:'PUT',path:route,mode:'disconnect-after' })).status,200);
    await assert.rejects(request(beta,route,{ method:'PUT',body,operationId:key }));
    const operation = await request(beta,`/api/v2/operations/${key}`); assert.equal(operation.status,200); assert.equal(operation.payload.data.operationReceipt.operationId,key);
    const retry = await request(beta,route,{ method:'PUT',body,operationId:key }); assert.equal(retry.status,200);
    assert.equal(retry.payload.data.replayed,true); assert.equal(retry.payload.data.current.signupRevision,prior.payload.data.signupRevision+1);
    const changed = await request(beta,route,{ method:'PUT',body:{...body,response:'not_attending'},operationId:key });
    assert.equal(changed.status,409); assert.equal(changed.payload.error.errorCode,'IDEMPOTENCY_CONFLICT');
  });
  await check('disconnect before processing gives only a temporary operation 404; identical retry can succeed', async () => {
    const route = `/api/v2/wipes/${runtime.nextWipeId}/my-signup`, prior = await request(beta,route);
    const wipe = await request(beta,`/api/v2/wipes/${runtime.nextWipeId}`), key = randomUUID();
    const body = {response:'attending_on_time',expectedArrivalAt:null,timeZone:'Asia/Shanghai',expectedSignupRevision:prior.payload.data.signupRevision,confirmedContentRevision:wipe.payload.data.contentRevision};
    await control({action:'fault',fixture:'beta',method:'PUT',path:route,mode:'disconnect-before'});
    await assert.rejects(request(beta,route,{method:'PUT',body,operationId:key}));
    assert.equal((await request(beta,`/api/v2/operations/${key}`)).status,404);
    const retry=await request(beta,route,{method:'PUT',body,operationId:key}); assert.equal(retry.status,200); assert.equal(retry.payload.data.replayed,false);
  });
  await check('scope revocation immediately invalidates the real cookie and old operation reads', async () => {
    assert.equal((await control({action:'revoke',fixture:'beta'})).status,200);
    assert.equal((await request(beta,'/api/v2/bootstrap')).status,401);
    beta=await login('beta'); assert.equal((await request(beta,'/api/v2/bootstrap')).status,200);
  });
  await check('SQLite integrity and durable business receipts survive all local HTTP scenarios', async () => {
    const r=await control({action:'inspect'}); assert.equal(r.status,200); assert.equal(r.payload.integrity,'ok');
    assert.ok(r.payload.signups.some(s=>s.memberId==='g05_beta' && s.signupRevision>=3));
    assert.ok(r.payload.receipts.length>=10); evidence.rows={signups:r.payload.signups.length,receipts:r.payload.receipts.length};
  });
  evidence.passed=true;
} catch(error) { evidence.failure={message:error.message,stack:error.stack}; process.exitCode=1; }
finally { evidence.finishedAt=new Date().toISOString(); await writeFile(path.join(runtime.runDir,'http-check.json'),JSON.stringify(evidence,null,2)); }
console.log(JSON.stringify(evidence,null,2));
