import { hash, need } from '../../stats/model.js';
import { AUDIT_KNOWN, AUDIT_ERRORS, discordId } from '../source-host/discord-membership.js';
const flagged = status => ['missing_role', 'not_in_guild'].includes(status);
/** Canonical audit fields only. No lifecycle, identity unlink or platform role mutations. */
export function applyDiscordAudit(member, result, config, observedAt) {
  need(result && [...AUDIT_KNOWN, 'check_failed'].includes(result.status) && result.discordUserId === config.discordId &&
    [member.discordId, member.discordUserId].filter(Boolean).every(id => id === config.discordId) &&
    result.guildId === config.guildId && hash(result.expectedRoleIds) === hash(config.expectedRoleIds), 'INVALID_DATA');
  for (const side of ['expected', 'actual']) {
    need(Array.isArray(result[`${side}RoleIds`]) && result[`${side}RoleIds`].length <= 500 && result[`${side}RoleIds`].every(discordId) &&
      Array.isArray(result[`${side}RoleNames`]) && result[`${side}RoleNames`].length === result[`${side}RoleIds`].length &&
      result[`${side}RoleNames`].every(n => typeof n === 'string' && n.length <= 100), 'INVALID_DATA');
  }
  const oldStatus = member.discordMembershipLastKnownStatus || (AUDIT_KNOWN.includes(member.discordMembershipStatus) ? member.discordMembershipStatus : '');
  need(result.status === 'check_failed' || result.status === 'not_in_guild' && result.actualRoleIds.length === 0 ||
    result.status === (config.matchMode === 'all'
      ? config.expectedRoleIds.every(id => result.actualRoleIds.includes(id)) ? 'valid' : 'missing_role'
      : config.expectedRoleIds.some(id => result.actualRoleIds.includes(id)) ? 'valid' : 'missing_role'), 'INVALID_DATA');
  need(!Object.hasOwn(result, 'discordAvatarHash') || result.discordAvatarHash === null ||
    typeof result.discordAvatarHash === 'string' && /^(a_)?[a-f0-9]{32}$/.test(result.discordAvatarHash), 'INVALID_DATA');
  const sameIdentityAndGuild = member.discordMembershipGuildId === result.guildId &&
    member.discordMembershipObservedDiscordId === result.discordUserId &&
    hash(member.discordMembershipExpectedRoleIds || []) === hash(result.expectedRoleIds);
  if (!sameIdentityAndGuild) {
    for (const key of ['MissingSince', 'LastOkAt', 'LastFailureAt', 'LastKnownStatus', 'LastKnownAt']) member[`discordMembership${key}`] = '';
  }
  member.discordMembershipCheckedAt = observedAt;
  if (!member.discordId) member.discordId = config.discordId;
  member.discordMembershipGuildId = result.guildId;
  member.discordMembershipObservedDiscordId = result.discordUserId;
  member.discordMembershipStatus = result.status;
  for (const side of ['expected', 'actual']) {
    const prefix = `discordMembership${side[0].toUpperCase()}${side.slice(1)}Role`;
    const oldNames = new Map((member[`${prefix}Ids`] || []).map((id, i) => [id, member[`${prefix}Names`]?.[i] || id]));
    member[`${prefix}Ids`] = result[`${side}RoleIds`];
    member[`${prefix}Names`] = result.roleNamesResolved === false && sameIdentityAndGuild
      ? result[`${side}RoleIds`].map(id => oldNames.get(id) || id) : result[`${side}RoleNames`];
  }
  member.discordMembershipError = result.status === 'check_failed' ? (AUDIT_ERRORS.includes(result.error) ? result.error : 'DISCORD_UNAVAILABLE') : '';
  if (result.status === 'check_failed') member.discordMembershipLastFailureAt = observedAt;
  else {
    member.discordMembershipLastKnownStatus = result.status; member.discordMembershipLastKnownAt = observedAt;
    if (result.status === 'valid') { member.discordMembershipLastOkAt = observedAt; member.discordMembershipMissingSince = ''; }
    else if (!sameIdentityAndGuild || !flagged(oldStatus) || !member.discordMembershipMissingSince) member.discordMembershipMissingSince = observedAt;
    if (result.discordName) member.discordName = result.discordName;
    if (Object.hasOwn(result, 'discordAvatarHash')) member.discordAvatarHash = result.discordAvatarHash || '';
  }
}
