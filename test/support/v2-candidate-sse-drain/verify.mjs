import { observations } from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { candidateConfig } from '../../../server/v2/candidate-host/config.js';
import { initializeCandidate, planCandidateMigration, applyCandidateMigration, createCandidateHost } from '../../../server/v2/candidate-host/index.js';

const [mode, raw] = process.argv.slice(2), config = candidateConfig(JSON.parse(raw));
const password = 'test-Synthetic-SSE-Drain-Password-2026';
let host, db, release;
const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'request settles');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
try {
  await initializeCandidate(config, { rootPassword: password });
  const plan = await planCandidateMigration(config);
  await applyCandidateMigration(config, plan, { expectedDigest: plan.digest, operatorId: 'user_root' });
  await (await import('../../../server/storage/sqlite.js')).closeSqliteDatabases();
  let entered = false;
  const bindings = mode === 'incomplete-action' ? { platformMetadata: { metadata: async () => {
    entered = true;
    await new Promise(resolve => { release = resolve; });
    return { schema: 'platform-result/1', state: 'succeeded', items: [] };
  } } } : {};
  host = createCandidateHost(config, { bindings });
  const { origin } = await host.start();
  db = (await host.owners().api.v2Runtime.getIdentity()).repo.db;
  const login = await fetch(origin + '/api/v2/auth/owner-password', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const csrf = (await login.json()).data.csrfToken;
  const stream = { 'client-stream': ['events', 'reset'], 'auth-stream': ['auth/events', 'ready'], 'members-stream': ['members/events', 'members'] }[mode];
  if (stream) {
    const streamUrl = origin + '/api/v2/' + stream[0];
    const controller = new AbortController();
    const response = await fetch(streamUrl, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    reader.closed.catch(() => {});
    assert.match(Buffer.from((await reader.read()).value).toString(), new RegExp('event: ' + stream[1]));
    controller.abort();
    await until(() => host.status().pendingRequests === 0);
    // Also leave a new stream open: its existing owner must drain it on stop.
    const active = await fetch(streamUrl, { headers: { Cookie: cookie } });
    assert.equal(active.status, 200);
    const activeReader = active.body.getReader();
    await activeReader.read();
    const stopped = await host.stop();
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.pendingRequests, 0);
    while (!(await activeReader.read()).done) {}
    assert.throws(() => db.prepare('SELECT 1'));
  } else {
    const detail = await fetch(origin + '/api/v2/platform-admin/discord', { headers: { Cookie: cookie } });
    assert.equal(detail.status, 200);
    const revision = (await detail.json()).data.revision;
    const controller = new AbortController();
    let completed;
    const request = fetch(origin + '/api/v2/platform-admin/discord/actions/metadata', {
      method: 'POST', signal: controller.signal,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ expectedRevision: revision })
    }).then(async response => { completed = { status: response.status, body: await response.json() }; return completed; }).catch(error => error);
    await until(() => entered || completed);
    assert.ok(entered, JSON.stringify(completed));
    controller.abort();
    await request;
    await until(() => host.status().pendingRequests === 0);
    release();
    await assert.rejects(host.stop(), error => error.errorCode === 'CANDIDATE_HTTP_DRAIN_UNCONFIRMED');
    assert.equal(db.prepare('SELECT 1 AS n').get().n, 1);
  }
  assert.equal(observations.forbiddenAttempts, 0);
  assert.equal(observations.externalNetworkAttempts, 0);
  console.log(JSON.stringify({ mode, state: host.status().state, observations }));
} finally {
  release?.();
  await host?.stop().catch(() => {});
  await (await import('../../../server/storage/sqlite.js')).closeSqliteDatabases();
  await fs.rm(config.dataDirectory, { recursive: true, force: true });
}
