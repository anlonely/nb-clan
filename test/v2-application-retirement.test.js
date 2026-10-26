import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createManagementRuntime } from '../server/v2/management-runtime/index.js';
import { validateBindings } from '../server/v2/candidate-host/bindings.js';
import { createCandidateWechat } from '../server/v2/candidate-host/wechat.js';

test('retired onboarding always responds 410 without initializing identity or accepting request data', async t => {
  let initialized = 0;
  const runtime = createManagementRuntime({ getIdentity() { initialized++; throw Error('retired endpoint initialized identity'); } });
  const app = express(); app.use('/api/v2', runtime.onboardingRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await runtime.stop(); });
  for (const path of ['', '/exchange', '/applications', '/applications/old-id', '/applications/old-id/cancel']) {
    for (const method of ['GET', 'POST', 'PUT']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/wechat-onboarding${path}`, { method });
      assert.equal(response.status, 410);
      assert.equal((await response.json()).error.errorCode, 'REGISTRATION_REVIEW_RETIRED');
    }
  }
  assert.equal(initialized, 0);
});

test('candidate rejects retired application bindings and preserves mini/inbox capability admission', () => {
  const binding = { enabled: true, appId: 'local_app', configurationRevision: 1,
    capabilities: { mini: true, inbox: true }, exchangeCode: async () => null };
  assert.doesNotThrow(() => validateBindings({ wechat: binding }));
  for (const value of [
    { memberReview: { readWechatProof: () => null } },
    { wechat: { ...binding, capabilities: { ...binding.capabilities, applications: true } } },
    { wechat: { ...binding, reviewNotifications: { enabled: true } } }
  ]) assert.throws(() => validateBindings(value));
  const identity = { repo: { db: {} } };
  const owner = createCandidateWechat({ binding, identity, getSystem: () => ({ identity,
    platforms: { service: { identity, repo: identity.repo, config: () => ({ id: 'wechat', enabled: true, appId: 'local_app', revision: 1 }) } } }) });
  assert.equal(owner.gate('/v2/wechat-onboarding/exchange'), false);
  assert.equal(owner.gate('/v2/mini-program/login'), true);
  assert.equal(owner.gate('/v2/member-inbox/settings'), true);
  assert.equal(owner.applicationOptions, undefined);
  assert.equal(owner.reviewOptions, undefined);
});
