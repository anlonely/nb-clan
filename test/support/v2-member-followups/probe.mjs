import '../results.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, 'test/support/v2-member-followups/.runtime'), { recursive: true });
const run = await mkdtemp(path.join(root, 'test/support/v2-member-followups/.runtime/run-'));
const filename = path.join(run, 'data.sqlite'), f = await fixture({ filename });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = { task: 'G07-member-followups-20260908-01', isolated: true, externalIO: false, filename, origin: f.origin,
  memberRouter: 'actual G03 + MemberAdminRouter', outbox: 'actual createMemberOutboxConsumer with agreed fixture after-domain hook',
  worker: 'actual createSyncCenterWorker', source: 'actual management-adapters/sources collector + authority; loopback Steam response', cases: [] };
try {
  const existing = f.ir.all('members').map(m => [m.id, hash(m)]), accounts = hash(f.ir.all('accounts'));
  for (const [endpoint, body] of [
    ['members', { steamInput: '76561198999999231', fields: { customName: '隔离录入成员' } }],
    ['reviews/review1', { expectedRevision: 1, status: 'approved', reason: '隔离审核通过' }]
  ]) {
    const headers = f.headers(), response = await fetch(f.origin + '/api/v2/member-admin/' + endpoint, {
      method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); const receipt = (await response.json()).data;
    const memberId = receipt.memberId || receipt.id, seq = f.latestSeq();
    const jobsBeforeConsume = f.jobs().length, callsBeforeConsume = f.calls.length;
    const drained = await f.consumer.drain(); await f.drain();
    const progress = f.followups.progress(seq), jobs = f.jobs().filter(j => j.items.some(i => i.memberId === memberId));
    assert.equal(jobs.length, 2); assert.ok(jobs.some(j => j.status === 'succeeded'));
    const member = f.ir.get('members', memberId), profiles = f.members.repo.find('memberProfiles', 'memberId', memberId, 3);
    assert.equal(profiles.length, 1); assert.equal(member.steamNickname, 'Loopback 已采集昵称');
    const replay = await f.followups.consume(seq); assert.deepEqual(replay, progress);
    report.cases.push({ endpoint, httpStatus: response.status, seq, jobsBeforeConsume, callsBeforeConsume, drained, progress,
      canonicalMember: { id: member.id, steamId: member.steamId, steamNickname: member.steamNickname },
      canonicalProfileCount: profiles.length, canonicalProfileSha256: hash(profiles[0]),
      jobs: jobs.map(j => ({ id: j.id, type: j.type, status: j.status, trigger: j.trigger, actorId: j.actorId,
        memberId: j.items[0].memberId, targetStatus: j.items[0].status, reason: j.items[0].reason })) });
  }
  assert.deepEqual(f.ir.all('members').filter(m => existing.some(([id]) => id === m.id)).map(m => [m.id, hash(m)]), existing);
  assert.equal(hash(f.ir.all('accounts')), accounts);
  report.originalMembersAndAccountsUnchanged = true;
  report.sourceCalls = f.calls; assert.ok(f.calls.every(c => c.memberTransaction === false));
  report.canonicalSourceReceipts = f.db.prepare('SELECT COUNT(*) n FROM v2_source_adapter_receipts').get().n;
  report.originalOutboxRows = f.db.prepare('SELECT COUNT(*) n FROM v2_member_admin_outbox').get().n;
  report.integrity = f.db.prepare('PRAGMA integrity_check').get().integrity_check;
  assert.equal(report.integrity, 'ok'); report.ok = true;
} finally { await f.close(); assert.throws(() => f.db.prepare('SELECT 1'), /not open|closed/); report.closed = true; }
await writeFile(path.join(root, 'output/test-results/g07-member-followups/probe-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
