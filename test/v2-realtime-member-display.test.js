import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRustplusRelayPayload } from '../server/rustplus-relay.js';
import { decodeRealtimeName, decodedRealtimeNames } from '../server/v2/realtime/names.js';
import { chatDTO, memberDTO } from '../server/v2/realtime/source.js';
import { defaultMemberSort, nextMemberSort, sortRealtimeMembers } from '../src/v2/realtime/member-sort.js';

test('literal Unicode escapes in member names are decoded on receipt and in saved snapshots', () => {
  const escaped = String.raw`\u767dBaiXun\u9c9f`;
  assert.equal(decodeRealtimeName(escaped), '白BaiXun鲟');
  assert.equal(decodeRealtimeName(String.raw`\uD83D\uDE00`), '😀');
  assert.equal(decodeRealtimeName(String.raw`\uD83D`), String.raw`\uD83D`);
  const normalized = normalizeRustplusRelayPayload({ type: 'clan_snapshot', clientId: 'collector-a', serverId: 'server-a',
    members: [{ steamId: '76561198341757432', displayName: escaped, online: false }] }, { receivedAt: '2026-09-28T00:00:00.000Z' });
  assert.equal(normalized.members[0].displayName, '白BaiXun鲟');

  assert.equal(memberDTO({ steamId: '76561198341757432', displayName: escaped }).displayName, '白BaiXun鲟');
  assert.deepEqual(chatDTO({ displayName: escaped, message: escaped }), { displayName: '白BaiXun鲟', message: escaped });
  const saved = JSON.parse(JSON.stringify({ steamId: '76561198341757432', displayName: escaped }));
  assert.equal(decodedRealtimeNames(saved, ['displayName']).displayName, '白BaiXun鲟');
});

test('member list defaults to latest online and each sort toggles with missing times last', () => {
  const members = [
    { displayName: 'Old', lastOnlineAt: '2026-09-27T00:00:00Z', online: false, registered: false },
    { displayName: 'Unknown', online: null, registered: false },
    { displayName: 'New', lastOnlineAt: '2026-09-28T00:00:00Z', online: true, registered: true, squadName: 'CN' }
  ];
  assert.deepEqual(sortRealtimeMembers(members, defaultMemberSort).map(m => m.displayName), ['New', 'Old', 'Unknown']);
  const ascending = nextMemberSort(defaultMemberSort, 'lastOnlineAt');
  assert.deepEqual(sortRealtimeMembers(members, ascending).map(m => m.displayName), ['Old', 'New', 'Unknown']);
  assert.deepEqual(sortRealtimeMembers(members, nextMemberSort(ascending, 'status')).map(m => m.displayName), ['New', 'Old', 'Unknown']);
});
