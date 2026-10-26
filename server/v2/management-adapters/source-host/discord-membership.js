import { hash, need, text } from '../../stats/model.js';
export const discordId = value => typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : '';
export const AUDIT_KNOWN = Object.freeze(['valid', 'missing_role', 'not_in_guild']);
export const AUDIT_ERRORS = Object.freeze(['DISCORD_TOKEN_INVALID', 'DISCORD_FORBIDDEN', 'DISCORD_RATE_LIMITED', 'DISCORD_NOT_FOUND_UNCONFIRMED', 'DISCORD_UNAVAILABLE', 'DISCORD_ROLE_CONFIG_INVALID', 'DISCORD_ROLES_CHANGED', 'SOURCE_TIMEOUT', 'SOURCE_RESPONSE_TOO_LARGE', 'SOURCE_INVALID_JSON', 'SOURCE_INVALID_DATA', 'SOURCE_REDIRECT_REJECTED', 'SOURCE_URL_REJECTED', 'SOURCE_METHOD_REJECTED', 'CREDENTIALS_CHANGED', 'PROXY_UNAVAILABLE']);
const ids = values => [...new Set(values)];
/** Legacy squad rule precedence, bounded and read-only. Ambiguous current squads fail closed. */
export function discordAuditConfiguration({ settings = {}, policy, externalId, member = {}, memberships = [], credentials, enabled }) {
  if (policy !== undefined) {
    const expectedRoleIds = Array.isArray(policy?.allowedRoleIds) ? ids(policy.allowedRoleIds.filter(discordId)) : [];
    const guildId = discordId(policy?.guildId), discordUserId = discordId(externalId);
    const matchMode = policy?.matchMode === 'all' ? 'all' : 'any';
    const policyValid = Array.isArray(policy?.allowedRoleIds) && policy.allowedRoleIds.length <= 500 &&
      policy.allowedRoleIds.length === expectedRoleIds.length && ['all', 'any'].includes(policy.matchMode);
    const aliases = [member.discordId, member.discordUserId].filter(Boolean);
    const credentialBinding = hash(credentials);
    return { enabled: Boolean(enabled && credentials.key && policy?.enabled && policyValid && guildId && expectedRoleIds.length &&
        discordUserId && aliases.every(id => id === discordUserId)),
      sourceId: 'discord', guildId, discordId: discordUserId, auditBinding: hash({ policy, externalId, memberId: member.id,
        memberDiscordId: member.discordId, memberDiscordUserId: member.discordUserId, credentialBinding }), credentialBinding,
      expectedRoleIds, expectedRoleNames: expectedRoleIds, matchMode, policyRevision: policy?.policyRevision || 0 };
  }
  const rawRules = settings.memberRegisterRoleSquadRules || [];
  need(Array.isArray(rawRules) && rawRules.length <= 500 && memberships.length <= 500, 'SOURCE_PAGE_LIMIT', 503);
  const rules = rawRules.filter(r => discordId(r?.roleId) && text(r.squadId, 120))
    .map(r => ({ roleId: r.roleId, squadId: text(r.squadId, 120), roleName: text(r.roleName, 100) }));
  if (!rules.length && discordId(settings.memberRegisterRoleId)) rules.push({ roleId: settings.memberRegisterRoleId, squadId: '', roleName: '' });
  const squads = ids(memberships.filter(s => !s.validTo).map(s => s.squadId)).sort();
  const exact = squads.length === 1 ? rules.filter(r => r.squadId === squads[0]) : [];
  const chosen = exact.length ? exact : rules;
  const expectedRoleIds = ids(chosen.map(r => r.roleId)), guildId = discordId(settings.guildId);
  const credentialBinding = hash(credentials);
  const binding = hash({ guildId, rules, configRevision: settings.revision || 0, updatedAt: settings.updatedAt || '',
    memberId: member.id || '', discordId: member.discordId || '',
    memberships, enabled, credentialBinding });
  return { enabled: Boolean(enabled && credentials.key && guildId && expectedRoleIds.length && squads.length <= 1),
    sourceId: 'discord', guildId, discordId: discordId(member.discordId), auditBinding: binding, credentialBinding,
    expectedRoleIds, expectedRoleNames: expectedRoleIds.map(id => chosen.find(r => r.roleId === id)?.roleName || id),
    matchMode: 'any' };
}
const failureCode = r => r.status === 401 ? 'DISCORD_TOKEN_INVALID' : r.status === 403 ? 'DISCORD_FORBIDDEN' : r.status === 429 ? 'DISCORD_RATE_LIMITED' : r.status === 404 ? 'DISCORD_NOT_FOUND_UNCONFIRMED' : 'DISCORD_UNAVAILABLE';
/** Two bounded GETs, no listing members, role writes, retry loop, messages or task queue. */
export function createDiscordMembershipReader(network) {
  return ({ member, config, signal }) => network.tracked(async ownedSignal => {
    need(config.enabled && discordId(config.discordId) &&
      [member.discordId, member.discordUserId].filter(Boolean).every(id => id === config.discordId), 'SOURCE_NOT_CONFIGURED', 503);
    const result = { discordUserId: config.discordId, guildId: config.guildId, expectedRoleIds: config.expectedRoleIds,
      expectedRoleNames: config.expectedRoleNames, actualRoleIds: [], actualRoleNames: [], roleNamesResolved: false };
    const options = { signal: ownedSignal, requireKey: true, expectedCredentialsHash: config.credentialBinding };
    const failed = (code, response) => ({ ...result, status: 'check_failed', error: code,
      ...(response?.status === 429 ? { retryAfterMs: Math.min(3600000, Math.max(1000, Number(response.headers.get('retry-after')) * 1000 || 60000)) } : {}) });
    try {
      const rolesResponse = await network.response('discord', `/api/v10/guilds/${config.guildId}/roles`, options);
      // Successful role dictionary also proves access to this guild. No 404 absence claim without it.
      if (rolesResponse.status !== 200) return failed(failureCode(rolesResponse), rolesResponse);
      const roles = await rolesResponse.json();
      need(Array.isArray(roles) && roles.length > 0 && roles.length <= 500 && roles.every(r => discordId(r?.id) && typeof r.name === 'string' && r.name.length <= 100) && ids(roles.map(r => r.id)).length === roles.length && roles.some(r => r.id === config.guildId), 'SOURCE_INVALID_DATA', 503);
      const names = new Map(roles.map(r => [r.id, r.name || r.id]));
      result.expectedRoleNames = result.expectedRoleIds.map(id => names.get(id) || id); result.roleNamesResolved = true;
      // A deleted/mistyped expected role is configuration uncertainty, not evidence against a member.
      if (result.expectedRoleIds.some(id => !names.has(id))) return failed('DISCORD_ROLE_CONFIG_INVALID');
      const response = await network.response('discord', `/api/v10/guilds/${config.guildId}/members/${config.discordId}`, options);
      const payload = await response.json();
      if (response.status === 404 && payload?.code === 10007) return { ...result, status: 'not_in_guild', error: '' };
      if (response.status !== 200) return failed(failureCode(response), response);
      need(payload?.user?.id === config.discordId && Array.isArray(payload.roles) && payload.roles.length <= 500 && payload.roles.every(discordId), 'SOURCE_INVALID_DATA', 503);
      need(!Object.hasOwn(payload.user, 'avatar') || payload.user.avatar === null ||
        typeof payload.user.avatar === 'string' && /^(a_)?[a-f0-9]{32}$/.test(payload.user.avatar), 'SOURCE_INVALID_DATA', 503);
      result.actualRoleIds = ids(payload.roles); result.actualRoleNames = result.actualRoleIds.map(id => names.get(id) || id);
      // Unknown roles may have changed between our two GETs; do not claim a role absence on mixed snapshots.
      if (result.actualRoleIds.some(id => !names.has(id))) return failed('DISCORD_ROLES_CHANGED');
      const actual = new Set(result.actualRoleIds);
      const matched = config.matchMode === 'all' ? result.expectedRoleIds.every(id => actual.has(id)) :
        result.expectedRoleIds.some(id => actual.has(id));
      return { ...result, status: matched ? 'valid' : 'missing_role', error: '',
        discordName: text(payload.nick || payload.user.global_name || payload.user.username, 120),
        ...(Object.hasOwn(payload.user, 'avatar') ? { discordAvatarHash: payload.user.avatar } : {}) };
    } catch (error) {
      need(!ownedSignal.aborted, 'SOURCE_TIMEOUT', 503);
      return failed(AUDIT_ERRORS.includes(error?.errorCode) ? error.errorCode : 'DISCORD_UNAVAILABLE');
    }
  }, signal, 3);
}
