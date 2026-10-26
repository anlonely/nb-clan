import { randomUUID } from 'node:crypto';
import { assertSteamLinksProof } from './proof.js';
import { isSteamIndividualId64 } from '../management-adapters/source-host/steam.js';
import { MemberAdminRepository, hash, requireValue as need } from '../member-admin/repository.js';
import { platformAliases, membershipStatus, legacyBlocked } from '../identity/migration.js';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x20\x7f]/.test(value);
const name = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : '';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Called only inside the Steam-link owner's transaction/savepoint. A Discord
 * declaration never creates a web account, a Steam proof or canonical Steam ID. */
export function createDiscordSteamMemberTeamSync({ identity, now = Date.now }) {
  const repo = identity.repo, db = repo.db;
  return function sync({ proof, link, team }) {
    assertSteamLinksProof(proof);
    need(db.isTransaction, 'STEAM_TEAM_TRANSACTION_REQUIRED', 503);
    need(snowflake(proof.externalId) && snowflake(proof.guildId) && identifier(proof.interactionId) &&
      link?.discordId === proof.externalId && link.guildId === proof.guildId && link.ownershipVerified === false &&
      isSteamIndividualId64(link.steamId) && ['CN', 'EU'].includes(team?.code) && identifier(team.squadId) &&
      identifier(team.targetId) && Array.isArray(team.roleIds) && team.roleIds.length > 0 && team.roleIds.length <= 250 &&
      team.roleIds.every(snowflake) && Array.isArray(proof.discordRoleIds) &&
      team.roleIds.some(role => proof.discordRoleIds.includes(role)), 'STEAM_TEAM_INPUT_INVALID', 422);
    const admin = new MemberAdminRepository(db), at = new Date(now()).toISOString();
    const result = (status, member, squadId) => ({ status, ...(member ? { memberId: member.id } : {}),
      ...(squadId ? { squadId } : {}), teamCode: team.code });
    const conflict = () => result('identity_conflict');
    const identities = repo.all('identities'), accounts = repo.all('accounts');
    const principalIdentities = identities.filter(row => row.provider === 'discord' && row.externalId === proof.externalId);
    const aliases = admin.all('members').filter(row => platformAliases(row, 'discord').includes(proof.externalId));
    const legacyUsers = repo.all('users').filter(row => platformAliases(row, 'discord').includes(proof.externalId));
    if (principalIdentities.length > 1 || aliases.length > 1 || legacyUsers.length > 1 ||
      [...aliases, ...legacyUsers].some(row => platformAliases(row, 'discord').some(id => id !== proof.externalId))) return conflict();
    const candidateAccountIds = new Set([
      ...principalIdentities.map(row => row.accountId),
      ...accounts.filter(row => aliases.some(member => row.memberId === member.id) ||
        legacyUsers.some(user => row.id === user.id || row.legacyUserId === user.id)).map(row => row.id)
    ]);
    if (candidateAccountIds.size > 1) return conflict();
    const account = candidateAccountIds.size ? repo.get('accounts', [...candidateAccountIds][0]) : null;
    if (candidateAccountIds.size && !account) return result('member_unavailable');
    if (account && identities.some(row => row.accountId === account.id && row.provider === 'discord' && row.externalId !== proof.externalId)) return conflict();
    const accountMember = account?.memberId ? repo.get('members', account.memberId) : null;
    if (account && (!accountMember || account.status !== 'active' || account.roleAccessLock)) return result('member_unavailable', accountMember);
    if (aliases[0] && accountMember && aliases[0].id !== accountMember.id) return conflict();
    let member = aliases[0] || accountMember;
    if (member && platformAliases(member, 'discord').some(id => id !== proof.externalId)) return conflict();
    if (legacyUsers.some(user => user.disabled || user.status === 'disabled' || user.roleAccessLock) ||
      !member && legacyUsers.length) return result('member_unavailable', member);
    // A prior website result anchors deleted members, including before the
    // person ever created a website account. Durable deletion events also cover
    // a first bot interaction after an administrator deleted an older member.
    const previousMemberId = link.teamSync?.memberId;
    if (previousMemberId && !repo.get('members', previousMemberId)) return result('member_unavailable');
    if (previousMemberId && !member) return result('member_unavailable');
    if (previousMemberId && member && previousMemberId !== member.id) return conflict();
    if (!member && repo.all('events').some(event => event.reason === 'member_deleted' && event.provider === 'discord' &&
      Array.isArray(event.externalIds) && event.externalIds.includes(proof.externalId))) return result('member_unavailable');
    if (member && (member.deletedAt || member.deleted || member.disabled || member.blocked || member.roleAccessLock ||
      legacyBlocked(member) || membershipStatus(member) !== 'active' || ['deleted', 'disabled', 'suspended', 'banned'].includes(member.status)))
      return result('member_unavailable', member);
    if (member && repo.all('restrictions').some(row => (row.memberId === member.id || account && row.accountId === account.id) &&
      (!row.startsAt || !Number.isFinite(Date.parse(row.startsAt)) || Date.parse(row.startsAt) <= now()) &&
      (!row.endsAt || !Number.isFinite(Date.parse(row.endsAt)) || Date.parse(row.endsAt) > now()))) return result('member_unavailable', member);
    // Canonical identity is only read, even if an administrator entered it
    // before the website's OpenID verification was available.
    if (member && (member.steamId && member.steamId !== link.steamId ||
      legacyUsers.some(user => user.boundSteamId && user.boundSteamId !== member.steamId) ||
      repo.all('bindings').some(binding => binding.memberId === member.id && binding.status === 'verified' &&
        (binding.steamId !== member.steamId || binding.steamId !== link.steamId || !account || binding.accountId !== account.id)))) return conflict();
    const squad = repo.get('squads', team.squadId);
    if (!squad || squad.archivedAt || squad.deletedAt || squad.deleted || squad.enabled === false ||
      ['archived', 'deleted', 'disabled'].includes(squad.status)) return result('squad_unavailable', member);
    const current = member ? repo.all('squadMembers').filter(row => row.memberId === member.id && !row.validTo) : [];
    if (current.length > 1) return conflict();
    const previous = member?.discordSteamTeam;
    const owned = previous?.guildId === proof.guildId && previous.squadId === current[0]?.squadId &&
      previous.relationId === current[0]?.id;
    const roleOwned = !previous && member?.roleDerivedSquad?.squadId === current[0]?.squadId && current.length === 1;
    const manualEmpty = member && !current.length && (previous || Object.hasOwn(member, 'discordSteamTeam') && member.discordSteamTeam === null || db.prepare(`SELECT 1 FROM v2_member_admin_history
      WHERE member_id=? AND (action LIKE 'member.move:%' OR action='member.moveMany' OR action LIKE 'squad.archive:%') LIMIT 1`).get(member.id));
    const manual = Boolean(current.length && !owned && !roleOwned || manualEmpty);
    const created = !member;
    if (!member) member = { id: `member_${randomUUID()}`, steamId: '', discordId: proof.externalId,
      discordName: name(proof.externalDisplayName) || proof.externalId, displayName: name(proof.externalDisplayName) || proof.externalId,
      customName: name(proof.externalDisplayName) || proof.externalId, steamNickname: '', specialty: [],
      memberStatus: 'active', membershipStatus: 'active', createdAt: at, revision: 1 };
    const previousDeclaration = member.discordSteamDeclaration;
    const declaration = { guildId: proof.guildId, discordId: proof.externalId, steamId: link.steamId, ownershipVerified: false,
      declaredAt: previousDeclaration?.guildId === proof.guildId && previousDeclaration.discordId === proof.externalId &&
        previousDeclaration.steamId === link.steamId && previousDeclaration.ownershipVerified === false ? previousDeclaration.declaredAt || at : at };
    const changes = [], events = [], actorId = `discord:${proof.externalId}`;
    const put = (collection, record) => { admin.put(collection, record); changes.push({ collection, id: record.id, record }); };
    const history = (kind, resourceId, payload, squadId = null) => db.prepare(`INSERT INTO v2_member_admin_history
      (kind,resource_id,member_id,squad_id,actor_id,action,payload,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(kind, resourceId, member.id, squadId, actorId, 'discord.steam_team.sync', JSON.stringify(payload), at);
    const next = { ...member, discordSteamDeclaration: declaration };
    let relation = current[0], nextSquadId = relation?.squadId;
    if (!manual) {
      if (relation?.squadId !== team.squadId) {
        if (relation) { admin.remove('squadMembers', relation.id); changes.push({ collection: 'squadMembers', id: relation.id, deleted: true }); }
        relation = { id: `squad_member_${randomUUID()}`, memberId: member.id, squadId: team.squadId,
          validFrom: at, validTo: null, createdAt: at, addedByUserId: actorId };
        put('squadMembers', relation);
        const transition = { fromSquadId: current[0]?.squadId || null, toSquadId: team.squadId, validFrom: at,
          source: 'discord_steam', guildId: proof.guildId, teamCode: team.code };
        history('member', member.id, transition, team.squadId);
        for (const squadId of new Set([current[0]?.squadId, team.squadId].filter(Boolean))) history('squad', squadId, { ...transition, memberId: member.id }, squadId);
        events.push({ changeType: 'member.squad', memberIds: [member.id], squadIds: [...new Set([current[0]?.squadId, team.squadId].filter(Boolean))] });
      }
      nextSquadId = team.squadId;
      next.discordSteamTeam = { guildId: proof.guildId, targetId: team.targetId, code: team.code, squadId: team.squadId,
        roleIds: [...new Set(team.roleIds)].sort(), relationId: relation.id };
      // Replace only an existing automatic source; do not leave an obsolete
      // OAuth mapping that could later delete this relationship on login.
      if (roleOwned) next.roleDerivedSquad = null;
    }
    const changed = created || !same(member, next) || changes.length > 0;
    if (!changed) return result(manual ? 'manual_preserved' : 'unchanged', member, nextSquadId);
    next.revision = created ? 1 : (member.revision || 1) + 1; next.updatedAt = at;
    put('members', next);
    history('member', member.id, { memberId: member.id, created, source: 'discord_steam', guildId: proof.guildId,
      teamCode: team.code, manualPreserved: manual }, nextSquadId || null);
    // This refreshes website projections without scheduling Steam collectors for
    // an intentionally blank canonical Steam identity.
    events.push({ changeType: 'member.profile', memberIds: [member.id], squadIds: nextSquadId ? [nextSquadId] : [] });
    db.prepare('UPDATE v2_member_admin_meta SET revision=revision+1 WHERE id=1').run();
    const operationId = `discord-steam-team:${proof.interactionId}`, data = result(manual ? 'manual_preserved' : 'synced', next, nextSquadId);
    const receipt = { operationId, data, changes, events, revision: admin.revision(), replayed: false };
    db.prepare('INSERT INTO v2_member_admin_operations VALUES(?,?,?,?,?)').run(actorId, operationId,
      hash([proof.guildId, proof.externalId, link.steamId, team]), JSON.stringify(receipt), at);
    db.prepare('INSERT INTO v2_member_admin_outbox(operation_id,payload,created_at) VALUES(?,?,?)').run(operationId,
      JSON.stringify({ schemaVersion: 1, actorId, events, changes: changes.map(({ collection, id, deleted }) => ({ collection, id, deleted: Boolean(deleted) })) }), at);
    return data;
  };
}
