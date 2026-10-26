// Synthetic data only. Never read production data or configure external targets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SEED = 20260908;
export function fixture(scale = 1) {
  assert.ok([1, 5].includes(scale));
  let state = SEED;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const stamp = '2026-09-08T00:00:00.000Z';
  const members = Array.from({ length: 100 * scale }, (_, i) => ({
    id: `fixture_member_${i}`, steamId: String(76561198000000000n + BigInt(i)),
    customName: `构造成员 ${String(i + 1).padStart(3, '0')}`, steamNickname: `Fixture ${i}`,
    memberStatus: i % 20 === 19 ? 'departed' : 'active', specialty: ['PVP'],
    avatar: '', discordId: '', battlemetricsId: '', invitedByUserId: 'user_root',
    createdAt: stamp, updatedAt: stamp
  }));
  const squads = Array.from({ length: 10 * scale }, (_, i) => ({ id: `fixture_squad_${i}`, name: `构造小队 ${i + 1}`, leaderUserId: '', leaderUserIds: [], createdAt: stamp }));
  const squadMembers = members.map((m, i) => ({ id: `fixture_relation_${i}`, memberId: m.id, squadId: squads[Math.floor(i / 10)].id, createdAt: stamp }));
  const wipes = Array.from({ length: 20 * scale }, (_, i) => ({
    id: `fixture_wipe_${i}`, serverName: `构造服务器 ${i + 1}`, serverIp: '',
    status: i === 0 ? 'active' : 'closed', startedAt: i === 0 ? '2035-09-10T12:00:00.000Z' : stamp,
    startedAtTimeZone: 'Asia/Shanghai', signupOpen: true, createdAt: stamp, updatedAt: stamp
  }));
  // Linear scale: 1,000 -> 5,000 records, rather than an accidental 25x cross product.
  const wipeParticipants = Array.from({ length: 1000 * scale }, (_, i) => ({
    id: `fixture_signup_${i}`, memberId: members[i % members.length].id,
    wipeId: wipes[Math.floor(i / members.length)].id,
    squadId: squadMembers[i % members.length].squadId,
    status: ['join', 'join_8h', 'join_16h', 'skip'][i % 4], source: 'fixture', updatedAt: stamp
  }));
  const kdaRows = wipeParticipants.map((p, i) => ({
    id: `fixture_kda_${i}`, wipeId: p.wipeId, memberId: p.memberId,
    steamId: members[i % members.length].steamId, kills: Math.floor(random() * 100),
    deaths: i % 9, assists: i % 5, syncedAt: stamp
  }));
  assert.equal(new Set(wipeParticipants.map(p => `${p.wipeId}:${p.memberId}`)).size, wipeParticipants.length);
  const data = { members, squads, squadMembers, wipes, wipeParticipants, kdaRows };
  return { data, manifest: {
    label: `S${scale}`, synthetic: true, seed: SEED, schema: 'legacy-fixture-1',
    clock: stamp, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex')
  } };
}

export function* cursorFixture(kind, count = 100000) {
  assert.ok(['chat', 'audit'].includes(kind));
  for (let i = 0; i < count; i++) yield {
    id: `fixture_${kind}_${String(i).padStart(6, '0')}`, sequence: i + 1,
    sourceId: 'fixture-relay', serverKey: `fixture-server-${i % 2}`,
    occurredAt: new Date(Date.UTC(2026, 8, 8) + i * 200).toISOString(),
    // 5% larger text payload; exact serialized record sizes are recorded by the runner.
    text: 'x'.repeat(i % 20 === 0 ? 8192 : 1024), synthetic: true
  };
}
