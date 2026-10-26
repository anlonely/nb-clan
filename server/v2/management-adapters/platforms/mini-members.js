import { authorize, can, memberDTO, validGrant, scopeMatches } from '../../identity/permissions.js';
import { membershipStatus } from '../../identity/migration.js';
import { normalizeSpecialties, specialties as specialtyLabels } from '../../../../shared/member-preferences.js';
import { normalizeRow, text, need } from '../../stats/model.js';

const participating = new Set(['attending_on_time', 'attending_later']);
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const minutes = value => numeric(value) === null ? null : Number(value) / 60;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const wipeStartsAt = wipe => date(wipe.serverScheduledWipeAt) || date(wipe.musterAt);
const httpsUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};
const avatar = httpsUrl;
const connectCommand = value => {
  if (typeof value !== 'string' || value.length > 300) return '';
  const target = value.trim().replace(/^(?:client\.connect|connect)\s+/i, '').replace(/^steam:\/\/connect\//i, '').replace(/\/$/, '');
  const match = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):([0-9]{1,5})$/.exec(target);
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 65535 ? `connect ${target}` : '';
};
const page = input => ({ offset: Math.min(10000, Math.max(0, Math.floor(Number(input.offset) || 0))),
  limit: Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 50))) });
const denied = (ctx, capability, resource) => (ctx.actor.grants || []).some(g => g.effect === 'deny' &&
  g.capability === capability && validGrant(g) && scopeMatches(g.scope, ctx.actor, resource, ctx.relations, 'deny', capability));

/** Member-only, deliberately small projections over the canonical data. */
export function createMiniMemberViews({ identity, scheduling, memberSpace, stats }) {
  const db = identity.repo.db, now = identity.now || Date.now;
  const records = (collection, where = '1', args = [], limit = 10000) => {
    const rows = db.prepare(`SELECT payload_json FROM json_records WHERE collection=? AND (${where}) ORDER BY id LIMIT ?`)
      .all(collection, ...args, limit + 1);
    need(rows.length <= limit, 'MINI_READ_LIMIT', 503);
    return rows.map(row => JSON.parse(row.payload_json));
  };
  function context(input) {
    const actor = memberSpace.actor(input);
    need(actor.memberId, 'MEMBER_VERIFICATION_REQUIRED', 403);
    const member = memberSpace.requireMember(actor);
    need(!member.deletedAt && membershipStatus(member) === 'active', 'MEMBERSHIP_INACTIVE', 403);
    const binding = identity.repo.all('bindings').find(row => row.accountId === actor.id && row.memberId === member.id && row.status === 'verified');
    need(binding && binding.steamId === member.steamId, 'MEMBER_VERIFICATION_REQUIRED', 403);
    return { actor, member, binding, relations: identity.relations() };
  }
  const profileFor = member => records('memberProfiles', "json_extract(payload_json,'$.memberId')=? AND json_extract(payload_json,'$.steamId')=?", [member.id, member.steamId], 10)
    .sort((a, b) => (Date.parse(b.fetchedAt || b.updatedAt) || 0) - (Date.parse(a.fetchedAt || a.updatedAt) || 0))[0] || {};
  function roster(ctx) {
    const squads = identity.repo.all('squads').filter(row => !row.archivedAt && !row.deletedAt);
    const squadMap = new Map(squads.map(s => [s.id, { id: s.id, name: text(s.name || s.displayName, 120) }]));
    const members = identity.repo.all('members').filter(row => !row.deletedAt && membershipStatus(row) === 'active' &&
      can(ctx.actor, 'members.directory', { kind: 'member', id: row.id }, ctx.relations) &&
      !denied(ctx, 'members.read', { kind: 'member', id: row.id }));
    const memberships = ctx.relations.squadMembers.filter(row => !row.validTo && squadMap.has(row.squadId));
    const items = members.map(member => ({ id: member.id, name: text(memberDTO(member).displayName, 120),
      steamNickname: text(member.steamNickname, 120), steamId: text(member.steamId, 32),
      avatar: avatar(member.avatar || member.steamAvatar || member.avatarUrl),
      specialties: normalizeSpecialties(member.specialty || member.specialties || []),
      squads: memberships.filter(row => row.memberId === member.id).map(row => squadMap.get(row.squadId)) }));
    return { items, squads: [...squadMap.values()].map(squad => ({ ...squad, count: items.filter(item => item.squads.some(s => s.id === squad.id)).length })) };
  }
  function visibleWipes(ctx) {
    return records('v2Wipes', "json_extract(payload_json,'$.lifecycle') IN ('scheduled','active','ended','archived')", [], 5000)
      .filter(wipe => can(ctx.actor, 'wipes.read', { kind: 'wipe', id: wipe.id }, ctx.relations))
      .sort((a, b) => (Date.parse(wipeStartsAt(b)) || 0) - (Date.parse(wipeStartsAt(a)) || 0));
  }
  function wipeDTO(ctx, wipe) {
    const server = wipe.serverSnapshot || {};
    const mine = can(ctx.actor, 'signups.read', { kind: 'signup', wipeId: wipe.id, memberId: ctx.member.id }, ctx.relations)
      ? memberSpace.signup(wipe, ctx.member.id) : null;
    return { id: wipe.id, title: text(wipe.title, 180), serverName: text(wipe.serverSnapshot?.name, 180),
      connectCommand: [server.connectCommand, server.directConnect, server.connect].map(connectCommand).find(Boolean) || '',
      mapUrl: [server.mapLink, server.mapUrl, server.rustMapsLink, server.mapImageUrl].map(httpsUrl).find(Boolean) || '',
      startsAt: wipeStartsAt(wipe), serverStartsAt: date(wipe.serverScheduledWipeAt),
      signupClosesAt: date(wipe.signupClosesAt), lifecycle: wipe.lifecycle,
      revision: wipe.revision, contentRevision: wipe.contentRevision, signupWindow: scheduling.window(wipe),
      timeZone: wipe.timeZone || 'Asia/Shanghai', mySignup: mine };
  }
  function identities(ctx, profile) {
    const linked = identity.repo.all('identities').filter(row => row.accountId === ctx.actor.id);
    const policies = identity.repo.all('policies'), evidence = identity.repo.all('eligibility');
    return [{ provider: 'steam', externalId: ctx.binding.steamId, displayName: text(profile.displayName || ctx.member.steamNickname, 120),
      avatarUrl: avatar(profile.avatar || ctx.member.avatar), verifiedAt: ctx.binding.verifiedAt || null, status: 'linked', roles: [] },
    ...['kook', 'discord'].map(provider => {
      const mapping = linked.find(row => row.provider === provider), policy = policies.find(row => row.provider === provider && row.enabled);
      if (!mapping) return { provider, externalId: null, displayName: '', avatarUrl: '', status: 'unlinked', roles: [] };
      const proof = evidence.filter(row => row.provider === provider && row.externalId === mapping.externalId && policy &&
        row.guildId === policy.guildId && row.policyRevision === policy.policyRevision)
        .sort((a, b) => (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0))[0];
      const community = proof?.community?.available === false ? null : proof?.community;
      const names = new Map((community?.roles || []).map(row => [String(row.id), text(row.name, 120)]));
      const communityUpdatedAt = date(proof?.communityCheckedAt || proof?.checkedAt);
      const metadataFresh = Date.parse(proof?.expiresAt) > now() && communityUpdatedAt &&
        Date.parse(communityUpdatedAt) + (identity.eligibilityTtl || 300000) > now();
      const matched = [ctx.member[`${provider}Id`], ctx.member[`${provider}UserId`], ctx.member[`${provider}AccountId`]].some(id => id && String(id) === mapping.externalId);
      return { provider, externalId: mapping.externalId, displayName: matched ? text(ctx.member[`${provider}Name`], 120) : '',
        avatarUrl: matched ? avatar(ctx.member[`${provider}Avatar`]) : '', verifiedAt: mapping.verifiedAt || null,
        status: mapping.verifiedAt ? 'linked' : 'unverified',
        roles: [...new Set(proof?.roleIds || [])].map(value => { const id = String(value), name = names.get(id); return { id, name: name && name !== id ? name : '' }; }),
        rolesUpdatedAt: communityUpdatedAt, rolesStatus: !proof || proof.status === 'unknown' ? 'unavailable' : metadataFresh ? 'fresh' : 'stale',
        communityName: text(community?.name, 120), communityAvatarUrl: avatar(community?.iconUrl),
        communityUpdatedAt, communityStatus: !community?.name ? 'unavailable' : metadataFresh ? 'fresh' : 'stale' };
    })];
  }
  function home({ actor: input }) {
    const ctx = context(input), p = profileFor(ctx.member), wipes = visibleWipes(ctx);
    const own = wipes.map(wipe => ({ wipe, dto: wipeDTO(ctx, wipe) })).filter(row => participating.has(row.dto.mySignup?.response));
    const current = own.filter(row => row.wipe.lifecycle === 'active');
    const history = own.filter(row => ['ended', 'archived'].includes(row.wipe.lifecycle) && row.wipe.outcome !== 'cancelled')
      .sort((a, b) => (Date.parse(b.wipe.endedAt || wipeStartsAt(b.wipe)) || 0) - (Date.parse(a.wipe.endedAt || wipeStartsAt(a.wipe)) || 0)).slice(0, 3);
    const bmWipe = current.find(row => row.wipe.id === p.battlemetricsWipeId);
    const source = p.officialKda || {}, officialValues = Object.fromEntries(['kills', 'deaths', 'rockets', 'sulfur', 'metalOre'].map(key => [key, numeric(source[key])]));
    officialValues.kd = officialValues.kills !== null && officialValues.deaths !== null ? Number((officialValues.kills / Math.max(1, officialValues.deaths)).toFixed(2)) : null;
    const role = identity.repo.get('permissionRoles', ctx.actor.roleId);
    const result = { member: { id: ctx.member.id, name: memberDTO(ctx.member).displayName, steamId: ctx.binding.steamId,
      steamNickname: text(p.displayName || ctx.member.steamNickname, 120), avatar: avatar(p.avatar || ctx.member.avatar || ctx.member.steamAvatar),
      profileUrl: `https://steamcommunity.com/profiles/${ctx.binding.steamId}/`, profilePublic: p.profilePublic ?? null,
      specialties: normalizeSpecialties(ctx.member.specialty || ctx.member.specialties || []),
      roles: ctx.actor.roleId ? [{ id: ctx.actor.roleId, name: text(role?.name || ({ owner: '所有者', admin: '管理员', member: '成员' })[ctx.actor.roleId] || ctx.actor.roleId, 120) }] : [],
      rustTotalMinutes: p.playTimeKnown === true && !['private', 'unknown'].includes(p.playTimeVisibility) ? numeric(p.playTimeMinutes) : null,
      wipeMinutes: bmWipe ? minutes(p.battlemetricsServerPlayTimeSeconds) : null,
      updatedAt: date(p.fetchedAt || p.sourceObservations?.steam_profile_backfill?.observedAt || p.sourceObservations?.member_profile?.observedAt),
      official: { status: p.officialKda ? p.officialKdaError ? 'stale' : 'available' : 'unavailable', updatedAt: date(p.officialKdaFetchedAt), values: officialValues },
      currentServers: current.map(({ dto }) => ({ wipeId: dto.id, name: dto.serverName, title: dto.title, startsAt: dto.startsAt })),
      recentWipes: history.map(({ wipe, dto }) => ({ id: dto.id, title: dto.title, serverName: dto.serverName, startsAt: dto.startsAt,
        endedAt: date(wipe.endedAt), response: dto.mySignup.response })) }, identities: identities(ctx, p) };
    return result;
  }
  function directory({ actor: input, input: query = {} }) {
    const ctx = context(input);
    authorize(ctx.actor, 'members.directory', { kind: 'member', id: ctx.member.id }, ctx.relations);
    need(query.specialty === undefined || typeof query.specialty === 'string', 'MINI_SPECIALTY_INVALID', 422);
    const all = roster(ctx), q = text(query.q, 120).toLocaleLowerCase(), squadId = text(query.squadId);
    const requestedSpecialty = text(query.specialty, 120), specialty = normalizeSpecialties([requestedSpecialty])[0];
    const items = all.items.filter(row => (!q || [row.name, row.steamNickname, row.steamId].some(value => value.toLocaleLowerCase().includes(q))) &&
      (!squadId || row.squads.some(s => s.id === squadId)) && (!requestedSpecialty || specialty && row.specialties.includes(specialty)))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    const paging = page(query);
    return { ...paging, items: items.slice(paging.offset, paging.offset + paging.limit), squads: all.squads,
      specialtyOptions: Object.entries(specialtyLabels).map(([id, label]) => ({ id, label })), total: items.length };
  }
  function wipes({ actor: input }) {
    const ctx = context(input);
    return { items: visibleWipes(ctx).filter(row => ['scheduled', 'active'].includes(row.lifecycle)).map(row => wipeDTO(ctx, row)) };
  }
  function rankings({ actor: input, input: query = {} }) {
    const ctx = context(input), rosterById = new Map(roster(ctx).items.map(row => [row.id, row]));
    const visible = visibleWipes(ctx).filter(w => stats.supportsVitalStats(w) &&
      !denied(ctx, 'stats.read', { kind: 'wipe', id: w.id }) && !stats.repo.db.prepare('SELECT hidden FROM v2_stats_visibility WHERE wipe_id=?').get(w.id)?.hidden);
    const wipe = query.wipeId ? visible.find(row => row.id === query.wipeId) : visible.find(row => row.lifecycle === 'active') || visible[0];
    need(!query.wipeId || wipe, 'RESOURCE_NOT_FOUND', 404);
    const metric = ['kills', 'deaths', 't3Kills', 'kd', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds'].includes(query.metric) ? query.metric : 'kills';
    const paging = page(query), base = { ...paging, metric, source: 'vital', wipeId: wipe?.id || null,
      wipes: visible.map(row => ({ id: row.id, title: text(row.title, 180), serverName: text(row.serverSnapshot?.name, 180) })) };
    if (!wipe) return { ...base, items: [], total: 0, updatedAt: null };
    authorize(ctx.actor, 'stats.ranking', { kind: 'wipe', id: wipe.id }, ctx.relations);
    const latestRevision = ['ended', 'archived'].includes(wipe.lifecycle) ? stats.repo.latest(wipe.id) : 0;
    const raw = latestRevision ? db.prepare('SELECT payload_json FROM v2_stats_archive_rows WHERE wipe_id=? AND revision=? AND source_id=? LIMIT 5001').all(wipe.id, latestRevision, 'vital').map(row => JSON.parse(row.payload_json))
      : records('kdaRows', "json_extract(payload_json,'$.wipeId')=? AND COALESCE(json_extract(payload_json,'$.sourceId'),json_extract(payload_json,'$.source'))='vital'", [wipe.id], 5000);
    need(raw.length <= 5000, 'MINI_READ_LIMIT', 503);
    const rows = raw.filter(row => rosterById.has(row.memberId) && can(ctx.actor, 'stats.ranking', { kind: 'member', id: row.memberId, wipeId: wipe.id }, ctx.relations) &&
      !denied(ctx, 'stats.read', { kind: 'member', id: row.memberId, wipeId: wipe.id }))
      .map(row => normalizeRow(row, { wipeId: wipe.id, serverId: wipe.serverProfileId, sourceId: 'vital' }, now()))
      .sort((a, b) => (b.values[metric] ?? -1) - (a.values[metric] ?? -1) || a.memberId.localeCompare(b.memberId));
    return { ...base, total: rows.length, updatedAt: rows.map(row => row.capturedAt).filter(Boolean).sort().at(-1) || null,
      items: rows.slice(paging.offset, paging.offset + paging.limit).map((row, index) => {
        const m = rosterById.get(row.memberId);
        return { memberId: m.id, name: m.name, avatar: m.avatar, squadName: m.squads.map(s => s.name).join('、'),
          rank: row.values[metric] === null ? null : paging.offset + index + 1, value: row.values[metric], values: row.values, status: row.status };
      }) };
  }
  return { home, directory, wipes, rankings };
}
