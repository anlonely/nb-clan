import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-platform-admin/fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';

const command = { id: 'setsteam', type: 'slash_command', slashCommand: 'setsteam', enabled: true, autoMatchTeamByRole: true };
const roles = { steamTeamCnRoleIds: ['100000000000000101'], steamTeamCnSquadId: 'g05_squad',
  steamTeamEuRoleIds: ['100000000000000102'], steamTeamEuSquadId: 'g05_foreign_squad' };
function setup(t) {
  const f = fixture(); t.after(() => f.close());
  // Production currently projects fixed system roles. Supply a scoped role at
  // that projection boundary to verify this policy guard also rejects delegated
  // platform-only editors; account.grants is intentionally not authoritative.
  const actorForAccount = f.identity.actorForAccount.bind(f.identity);
  f.identity.actorForAccount = id => {
    const actor = actorForAccount(id);
    return id === 'g05_account_leader' ? { ...actor, grants: [...actor.grants,
      ...['platforms.read', 'platforms.configure'].map(cap => grant(cap, { type: 'platformTargets', ids: ['discord'] }))] } : actor;
  };
  return f;
}
const save = (f, actor, config) => f.service.save(actor, 'discord', { expectedRevision: f.service.config('discord').revision, config }, { operationId: randomUUID() });
test('platform configuration alone cannot delegate website member/team writes', t => {
  const f = setup(t), actor = f.actor('leader'), before = f.service.config('discord');
  assert.equal(f.service.detail(actor, 'discord').canConfigureSteamTeams, false);
  assert.throws(() => save(f, actor, { commands: [command] }), /ACCESS_DENIED/);
  assert.throws(() => save(f, actor, { targets: before.targets.map(row => ({ ...row, ...roles })) }), /ACCESS_DENIED/);
  assert.equal(f.service.config('discord').revision, before.revision);
  save(f, actor, { commands: [{ ...command, autoMatchTeamByRole: false }] });
});
test('mapping validates live website squads and both independently saved editor sections', t => {
  const f = setup(t), actor = f.actor(), before = f.service.config('discord');
  assert.equal(f.service.detail(actor, 'discord').canConfigureSteamTeams, true);
  assert.throws(() => save(f, actor, { targets: before.targets.map(row => ({ ...row, ...roles, steamTeamCnSquadId: 'missing' })) }), /SQUAD_UNAVAILABLE/);
  const target = { ...before.targets[0], ...roles, enabledCommandIds: ['setsteam'] };
  save(f, actor, { targets: [target] });
  save(f, actor, { commands: [command] });
  assert.equal(f.service.config('discord').targets[0].steamTeamCnSquadId, 'g05_squad');
  assert.throws(() => save(f, f.actor('leader'), { targets: [{ ...target, channelId: '300000000000000099' }] }), /ACCESS_DENIED/);
  // Routine labels do not confer new automatic write authority.
  save(f, f.actor('leader'), { commands: [{ ...command, name: 'Label only' }] });
  assert.throws(() => save(f, f.actor('leader'), { enabled: false }), /ACCESS_DENIED/);
});
test('disabled defaults remain compatible and explicit squad deny blocks configuration', t => {
  const f = setup(t), actor = f.actor('leader');
  save(f, actor, { commands: [{ ...command, autoMatchTeamByRole: false }] });
  save(f, actor, { commands: [{ id: 'setsteam', type: 'slash_command', slashCommand: 'setsteam', enabled: true }] });
  const actorForAccount = f.identity.actorForAccount;
  f.identity.actorForAccount = id => { const a = actorForAccount(id); return id === 'g05_account_admin' ?
    { ...a, grants: [...a.grants, { ...grant('squads.manage', { type: 'squads', ids: ['g05_squad'] }), effect: 'deny' }] } : a; };
  assert.throws(() => save(f, f.actor(), { targets: f.service.config('discord').targets.map(row => ({ ...row, ...roles })) }), /ACCESS_DENIED/);
});
