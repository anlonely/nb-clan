import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthFlow, safeAuthReturnTo } from '../src/v2/auth-flow.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const onboarding = { provider: 'discord', displayName: 'Old identity', csrfToken: 'onboarding-token',
  step: 'steam', allowedActions: ['steam', 'retry', 'cancel'], returnTo: '/app/wipes/w1' };

function fixture(t, request) {
  let generation = 0, identity = null;
  const changes = [], visits = [], redirects = [];
  const client = { request, getGeneration: () => generation, getIdentity: () => identity };
  const make = (options = {}) => {
    const flow = createAuthFlow({ client, continuing: false, returnTo: '/app/wipes/w1?tab=plan',
      onChange: state => changes.push(state), go: (...args) => visits.push(args), redirect: url => redirects.push(url),
      refreshSession: async () => { identity = { accountId: 'a1' }; generation++; return identity; }, ...options });
    t.after(() => flow.dispose()); return flow;
  };
  return { client, make, changes, visits, redirects,
    switchAccount(accountId) { identity = { accountId }; generation++; } };
}

test('a disposed continuation read cannot overwrite the newer provider step even if cancellation is ignored', async t => {
  const old = deferred(), next = deferred(), calls = [];
  const f = fixture(t, (path, options) => { calls.push({ path, signal: options.signal }); return path.endsWith('/continue') ? old.promise : next.promise; });
  const previousStep = f.make({ continuing: true }); const pendingOld = previousStep.load(); await tick();
  previousStep.dispose(); const newStep = f.make(); const pendingNew = newStep.load(); await tick();
  next.resolve({ data: { providers: [{ provider: 'kook', enabled: true }] } }); await pendingNew;
  const newVisibleState = f.changes.at(-1), notifications = f.changes.length;
  old.resolve({ data: onboarding }); await pendingOld;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(f.changes.length, notifications); assert.strictEqual(f.changes.at(-1), newVisibleState);
  assert.equal(f.changes.at(-1).data.providers[0].provider, 'kook');
  assert.equal(f.changes.some(state => state.data?.displayName === 'Old identity'), false);
});

test('a second read wins over a first delayed read or error and cancels its signal', async t => {
  const first = deferred(), second = deferred(), calls = [];
  const f = fixture(t, (_path, options) => { calls.push(options.signal); return calls.length === 1 ? first.promise : second.promise; });
  const flow = f.make({ continuing: true }), a = flow.load(); await tick(); const b = flow.load(); await tick();
  second.resolve({ data: { ...onboarding, step: 'eligibility', allowedActions: ['retry'], displayName: 'Current step' } }); await b;
  first.reject(new Error('late old failure')); await a;
  assert.equal(calls[0].aborted, true); assert.equal(flow.getState().data.displayName, 'Current step');
  assert.equal(flow.getState().error, null); assert.equal(flow.getState().loading, false);
});

test('leaving during a Steam start cancels the request and prevents a late external redirect', async t => {
  const start = deferred(); let signal;
  const f = fixture(t, (path, options) => path.endsWith('/continue') ? Promise.resolve({ data: onboarding }) : (signal = options.signal, start.promise));
  const flow = f.make({ continuing: true }); await flow.load();
  const pending = flow.act('steam/start'); await tick(); flow.dispose();
  const count = f.changes.length; start.resolve({ data: { authorizationUrl: 'https://steam.example/late' } }); await pending;
  assert.equal(signal.aborted, true); assert.equal(f.redirects.length, 0); assert.equal(f.changes.length, count);
  assert.equal(flow.getState().data, null);
});

test('a delayed login bootstrap cannot navigate after the member left the login step', async t => {
  const bootstrap = deferred(); let signal;
  const f = fixture(t, async () => ({ data: { returnTo: '/app/wipes/w1?tab=plan' } }));
  const flow = f.make({ refreshSession: ({ signal: value }) => { signal = value; return bootstrap.promise; } });
  const pending = flow.passwordLogin({ username: 'admin', password: 'ephemeral' }); await tick(); flow.dispose();
  f.switchAccount('a1'); bootstrap.resolve({ accountId: 'a1' }); await pending;
  assert.equal(signal.aborted, true); assert.equal(f.visits.length, 0);
  assert.equal(f.changes.some(state => JSON.stringify(state).includes('ephemeral')), false);
});

test('login waits for an adopted bootstrap; failure stays on the original deep link', async t => {
  const f = fixture(t, async () => ({ data: { returnTo: '/app/wipes/w1?tab=plan' } }));
  const flow = f.make({ refreshSession: async () => null });
  await flow.passwordLogin({ username: 'admin', password: 'ephemeral' });
  assert.equal(f.visits.length, 0); assert.equal(flow.getState().error.errorCode, 'AUTH_REFRESH_REQUIRED');
  assert.equal(flow.getState().busy, false);
});

test('successful login uses its confirmed session and retains the deep link; duplicate submits share the flow', async t => {
  let writes = 0, captured;
  const f = fixture(t, async (_path, options) => { writes++; captured = options; return { data: { returnTo: '/app/wipes/w1?tab=plan' } }; });
  const flow = f.make();
  const first = flow.passwordLogin({ username: 'admin', password: 'ephemeral' });
  const second = flow.passwordLogin({ username: 'admin', password: 'ephemeral' }); await Promise.all([first, second]);
  assert.equal(writes, 1); assert.equal(captured.body.returnTo, '/app/wipes/w1?tab=plan');
  assert.deepEqual(f.visits, [['/app/wipes/w1?tab=plan', { replace: true }]]);
});

test('a changed identity cannot reuse a late old Steam authorization response', async t => {
  const start = deferred();
  const f = fixture(t, path => path.endsWith('/continue') ? Promise.resolve({ data: onboarding }) : start.promise);
  const flow = f.make({ continuing: true }); await flow.load(); const pending = flow.act('steam/start'); await tick();
  f.switchAccount('a2'); start.resolve({ data: { authorizationUrl: 'https://steam.example/old-account' } }); await pending;
  assert.equal(f.redirects.length, 0); assert.equal(flow.getState().data, null); assert.equal(flow.getState().busy, false);
});

test('cancelled onboarding returns to its safe original target and never starts another login automatically', async t => {
  const f = fixture(t, path => Promise.resolve({ data: path.endsWith('/continue') ? onboarding : { cancelled: true } }));
  const flow = f.make({ continuing: true }); await flow.load(); await flow.act('cancel');
  assert.deepEqual(f.visits, [['/login?returnTo=%2Fapp%2Fwipes%2Fw1']]); assert.equal(f.redirects.length, 0);
  for (const target of ['//evil.example/app/home', '/app/../../auth/callback', '/app/%2e%2e/admin/', '/app/%5cevil', '/app/%252fevil']) assert.equal(safeAuthReturnTo(target), '/app/home');
});
