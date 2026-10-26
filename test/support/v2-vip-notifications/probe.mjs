import '../results.mjs';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';
const report = { task: 'G07-vip-notifications-20260908-01', mode: 'isolated-loopback', realPlatformVerified: false,
  constructed: ['accounts', 'verified Steam bindings', 'membership', 'Discord guild roles', 'existing DM channel', 'VIP purchase and expiry facts'],
  transport: 'original NotificationSystem/worker → createNotificationPlatforms → native request builder → owned loopback HTTP', stages: [] };
const directory = mkdtempSync(join(tmpdir(), 'vip-probe-')), filename = join(directory, 'fixture.sqlite');
let f;
try {
  f = await fixture({ filename }); const accounts = f.ir.all('accounts'), bindings = f.ir.all('bindings');
  const write = await f.setVip(); const page = await f.vip.tick({ limit: 5 });
  assert.equal(page.queued, 1); assert.equal(f.calls.length, 0);
  report.stages.push({ stage: 'original member PATCH and atomic bounded scan', operationId: write.operationId, page });
  await f.drain(); const d = f.deliveries()[0]; assert.equal(d.status, 'sent');
  const ref = f.notifications.service.repo.all('messageRefs')[0];
  assert.deepEqual(f.calls.map(c => c.method), ['POST', 'PATCH']); assert.equal(ref.guildId, null); assert.equal(ref.messageUrl, null);
  const read = await f.request(`/deliveries/${d.id}`); assert.equal(read.status, 200);
  assert.deepEqual(f.ir.all('accounts'), accounts); assert.deepEqual(f.ir.all('bindings'), bindings);
  report.stages.push({ stage: 'original native DM send and same-message edit', deliveryId: d.id, resource: d.resource,
    status: d.status, attemptCount: d.attemptCount, nativeRequests: f.calls.map(c => ({ method: c.method, path: c.path, persistedAttemptId: c.attemptId })),
    reference: { messageId: ref.messageId, channelId: ref.channelId, guildId: ref.guildId, messageUrl: ref.messageUrl }, g03HttpRead: read.status });
  await f.close(); f = await fixture({ filename }); await f.setVip();
  const restored = await f.vip.tick({ limit: 5 }); assert.equal(restored.cursor, 'm010');
  await f.scan(); f.advance(3600000); await f.refreshProofs(); await f.scan(); await f.drain();
  assert.equal(f.deliveries().length, 1); assert.equal(f.calls.length, 0);
  report.stages.push({ stage: 'SQLite reopen continues committed cursor, next cycle preserves period dedupe', restoredPage: restored,
    scan: f.vip.scanState(), deliveryRows: f.deliveries().length, repeatedNativeCalls: f.calls.length });
  await f.close(); f = await fixture(); await f.setVip(); await f.scan();
  f.fault = async ({ res }) => { res.status(503).json({ constructed: 'ambiguous provider result' }); return true; };
  await f.run(); assert.equal(f.deliveries()[0].status, 'delivery_unknown');
  f.advance(3600000); await f.refreshProofs(); await f.scan(); await f.run(); assert.equal(f.calls.length, 1);
  report.stages.push({ stage: 'ambiguous result cannot automatically resend', status: f.deliveries()[0].status,
    sendAttempts: f.deliveries()[0].attemptCount, nativeCallsAcrossRescan: f.calls.length });
  report.noSynthesizedAccountOrBinding = true; report.noDmChannelCreation = true; report.ok = true;
} finally { await f?.close(); rmSync(directory, { recursive: true, force: true }); }
const output = fileURLToPath(new URL('../../../output/test-results/g07-vip-notifications/probe-report.json', import.meta.url));
writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); chmodSync(output, 0o644);
console.log(JSON.stringify({ ok: report.ok, output, stages: report.stages.length, realPlatformVerified: false }));
