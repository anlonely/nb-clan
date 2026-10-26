import assert from 'node:assert/strict';
import test from 'node:test';

import { battlemetricsOnlineSummaryTrustedForWipe } from '../server/api.js';

const activeWipe = {
  id: 'wipe_current',
  name: 'Vital Rust 2X EU Medium',
  status: 'active',
  serverName: 'Vital Rust 2X EU Medium',
  battlemetricsId: '32032048',
  startedAt: '2026-06-18T15:59:22.000Z'
};

test('rustplus fallback without direct BattleMetrics session evidence is not trusted', () => {
  assert.equal(battlemetricsOnlineSummaryTrustedForWipe({
    wipeId: activeWipe.id,
    battlemetricsPlayerId: '1106296105',
    battlemetricsServerId: activeWipe.battlemetricsId,
    serverPlayTimeSeconds: 76345,
    syncedAt: '2026-06-21T11:43:46.688Z',
    matchConfidence: 'rustplus_relay_bmid',
    matchNotes: 'Rust+ relay online fallback by BMID'
  }, activeWipe, Date.parse('2026-06-21T12:00:00.000Z')), false);
});

test('BattleMetrics session fetch for a cached rustplus BMID is trusted for the current wipe', () => {
  assert.equal(battlemetricsOnlineSummaryTrustedForWipe({
    wipeId: activeWipe.id,
    battlemetricsPlayerId: '1106296105',
    battlemetricsServerId: activeWipe.battlemetricsId,
    lastOnlineAt: '2026-06-21T11:10:57.392Z',
    serverPlayTimeSeconds: 76345,
    syncedAt: '2026-06-21T11:43:46.688Z',
    rangeStopAt: '2026-06-21T11:43:37.327Z',
    sessionFetchedPages: 1,
    sessionPageLimit: 12,
    matchConfidence: 'rustplus_relay_bmid',
    matchNotes: 'Rust+ relay online fallback by BMID; cached BM ID verified on current server'
  }, activeWipe, Date.parse('2026-06-21T12:00:00.000Z')), true);
});
