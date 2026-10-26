import { deploymentText } from '../../branding.js';
import { IdentityError } from '../identity/errors.js';
import { authorize, can, memberDTO, scopeMatches, validGrant } from '../identity/permissions.js';
import { SchedulingRepository } from '../scheduling/repository.js';
import { SchedulingService, hash } from '../scheduling/service.js';
import { validateTimeZone } from '../scheduling/time.js';
import { MemberSpaceRepository } from './repository.js';
import { workspaceCapabilities } from './workspaces.js';
import { managementSections, systemManagementSection } from './management-sections.js';
import { normalizeSpecialties } from '../../../shared/member-preferences.js';
import { displayLogoUrl } from '../system-admin/model.js';
import { PlatformMediaRepository } from '../platform-media/repository.js';
import { digest } from '../platform-media/model.js';

export const EDITABLE_PROFILE_FIELDS = Object.freeze(['displayName', 'specialty', 'timeZone', 'language', 'theme']);
const need = (condition, code, status = 403, options) => { if (!condition) throw new IdentityError(code, status, options); };
const clean = value => typeof value === 'string' ? value.trim() : '';
const platformAvatar = (value, provider) => {
  try {
    const url = new URL(value);
    const hosts = provider === 'kook' ? ['img.kookapp.cn', 'img.kaiheila.cn'] : ['cdn.discordapp.com', 'media.discordapp.net'];
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash ? url.href : '';
  } catch { return ''; }
};
const textValid = (value, max, allowEmpty = false) => typeof value === 'string' && (allowEmpty || value.trim().length > 0) &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export class MemberSpaceService {
  constructor(identity, { now = identity.now, scheduling } = {}) {
    this.identity = identity; this.now = now;
    this.repo = new MemberSpaceRepository(identity.repo.db);
    need(!scheduling || scheduling.identity === identity, 'SCHEDULING_IDENTITY_MISMATCH', 503);
    this.scheduling = scheduling || new SchedulingService(new SchedulingRepository(identity.repo.db), identity, { now });
  }
  actor(input) {
    const actor = this.identity.actorForAccount(input?.id);
    need(actor.permissionVersion === input.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    return actor;
  }
  relations(memberIds, wipe = null) {
    return { squadMembers: this.repo.memberships([...new Set(memberIds.filter(Boolean))]), wipes: wipe ? [wipe] : [] };
  }
  requireMember(actor, capability = 'members.read') {
    need(actor.memberId, 'MEMBER_VERIFICATION_REQUIRED');
    const member = this.repo.get('members', actor.memberId);
    need(member, 'MEMBER_VERIFICATION_REQUIRED');
    authorize(actor, capability, { kind: 'member', id: actor.memberId }, this.relations([actor.memberId]));
    return member;
  }
  profile(member) {
    if (!member) return null;
    const dto = memberDTO(member);
    return { ...dto, avatar: member.avatar || member.steamAvatar || member.avatarUrl || '', specialty: normalizeSpecialties(member.specialty || member.specialties || []),
      timeZone: member.timeZone || member.timezone || null, timeZoneExplicit: Boolean(member.timeZone || member.timezone), language: ['zh-CN', 'en'].includes(member.language) ? member.language : 'zh-CN',
      theme: ['dark', 'light', 'system'].includes(member.theme) ? member.theme : 'light' };
  }
  participation(actor, relations = this.relations([actor.memberId])) {
    const reasonCode = !actor.memberId ? 'MEMBER_VERIFICATION_REQUIRED' : actor.memberStatus !== 'active' ? 'MEMBERSHIP_INACTIVE' :
      !can(actor, 'signups.self_write', { kind: 'member', id: actor.memberId }, relations) ? 'ACCESS_DENIED' : null;
    return { canSignup: !reasonCode, reasonCode };
  }
  canEditProfile(actor) {
    const selfEditor = { ...actor, grants: [...actor.grants, { capability: 'members.basic_edit', scope: { type: 'self' }, effect: 'allow' }] };
    return can(selfEditor, 'members.basic_edit', { kind: 'member', id: actor.memberId }, this.relations([actor.memberId]));
  }
  bootstrap(input, csrfToken) {
    const actor = this.actor(input), relations = this.relations([actor.memberId]);
    const memberReadable = Boolean(actor.memberId && can(actor, 'members.read', { kind: 'member', id: actor.memberId }, relations));
    const member = memberReadable ? this.repo.get('members', actor.memberId) : null, profile = this.profile(member);
    return { accountId: actor.id, memberId: actor.memberId, displayName: profile?.displayName || '',
      roleId: actor.roleId || null, membershipStatus: actor.memberStatus || null, grants: actor.grants,
      participation: this.participation(actor), csrfToken, member: profile,
      workspaces: workspaceCapabilities(this.identity, actor, { memberReadable: Boolean(member), relations }),
      managementSections: [
        ...(workspaceCapabilities(this.identity, actor, { memberReadable: Boolean(member), relations, schedulingOnly: true }).admin ? [{ id: 'wipes', path: '/admin/wipes' }] : []),
        ...managementSections(actor, relations, actor.grants, this.identity),
        ...systemManagementSection(this.identity, actor)
      ],
      brand: { name: deploymentText("Clan Portal"), logoUrl: displayLogoUrl(this.identity.repo.scalar('settings')?.system?.teamLogoUrl) }, languageVersion: 1 };
  }
  me(input) {
    const actor = this.actor(input), member = this.requireMember(actor), binding = this.repo.bindings(actor.id)[0];
    return { profile: this.profile(member), bindings: {
      steam: { status: binding?.status || 'unverified', steamId: binding?.steamId || null, verifiedAt: binding?.verifiedAt || null },
      platforms: this.repo.platforms(actor.id).map(row => {
        const aliases = row.provider === 'discord' ? [member.discordId, member.discordUserId] : row.provider === 'kook' ? [member.kookId, member.kookUserId, member.kookAccountId] : [];
        const matched = aliases.some(id => id && String(id) === row.externalId);
        const wechat = row.provider.startsWith('wechat:');
        const wechatUser = wechat ? this.identity.repo.all('wechatUsers').find(user =>
          user.memberId === actor.memberId && user.appId === row.provider.slice(7) && user.openid === row.externalId) : null;
        return { provider: row.provider, verifiedAt: row.verifiedAt || null,
          externalId: ['discord', 'kook'].includes(row.provider) ? row.externalId || null : null,
          displayName: wechat ? clean(wechatUser?.nickname) : clean(row.displayName) ||
            (matched ? clean(row.provider === 'discord' ? member.discordName : member.kookName) : '') };
      })
    }, editableFields: this.canEditProfile(actor) ? [...EDITABLE_PROFILE_FIELDS] : [] };
  }
  patchMe(inputActor, input, { operationId } = {}) {
    return this.repo.transaction(() => {
      const actor = this.actor(inputActor), member = this.requireMember(actor);
      // Editing one's own display preferences is a narrow member operation, never a general members.basic_edit grant.
      // An explicit self/basic-edit deny still defeats this default operation.
      need(this.canEditProfile(actor), 'ACCESS_DENIED');
      need(typeof operationId === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(operationId), 'IDEMPOTENCY_KEY_REQUIRED', 422);
      need(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_PROFILE', 422);
      const key = hash([actor.id, operationId]);
      const commandHash = hash({ memberId: actor.memberId, input }), existing = this.repo.get('v2MemberProfileReceipts', key);
      if (existing) {
        need(existing.commandHash === commandHash, 'IDEMPOTENCY_CONFLICT', 409);
        return { operationReceipt: existing.operationReceipt, current: this.me(actor), replayed: true };
      }
      const errors = Object.create(null);
      for (const key of Object.keys(input)) if (key !== 'expectedRevision' && !EDITABLE_PROFILE_FIELDS.includes(key)) errors[key] = 'FIELD_NOT_EDITABLE';
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) errors.expectedRevision = 'REVISION_REQUIRED';
      if (!EDITABLE_PROFILE_FIELDS.some(key => Object.hasOwn(input, key))) errors.profile = 'PROFILE_CHANGE_REQUIRED';
      if (Object.hasOwn(input, 'displayName') && !textValid(input.displayName, 80)) errors.displayName = 'DISPLAY_NAME_INVALID';
      if (Object.hasOwn(input, 'specialty') && (!Array.isArray(input.specialty) || input.specialty.length > 12 || input.specialty.some(x => !textValid(x, 40)))) errors.specialty = 'SPECIALTY_INVALID';
      if (Object.hasOwn(input, 'specialty')) { try { normalizeSpecialties(input.specialty, { strict: true }); } catch { errors.specialty = 'SPECIALTY_INVALID'; } }
      if (Object.hasOwn(input, 'timeZone')) {
        try { need(typeof input.timeZone === 'string' && input.timeZone.length <= 80, 'TIME_ZONE_INVALID', 422); validateTimeZone(input.timeZone); }
        catch { errors.timeZone = 'TIME_ZONE_INVALID'; }
      }
      if (Object.hasOwn(input, 'language') && !['zh-CN', 'en'].includes(input.language)) errors.language = 'LANGUAGE_INVALID';
      if (Object.hasOwn(input, 'theme') && !['dark', 'light', 'system'].includes(input.theme)) errors.theme = 'THEME_INVALID';
      need(!Object.keys(errors).length, 'INVALID_PROFILE', 422, { fieldErrors: errors });
      need(input.expectedRevision === (member.revision || 1), 'REVISION_CONFLICT', 409, { current: this.me(actor) });
      const changed = {};
      for (const key of EDITABLE_PROFILE_FIELDS) if (Object.hasOwn(input, key)) changed[key] = input[key];
      if (Object.hasOwn(changed, 'displayName')) { changed.displayName = clean(changed.displayName); changed.customName = changed.displayName; }
      if (Object.hasOwn(changed, 'specialty')) { changed.specialty = normalizeSpecialties(changed.specialty, { strict: true }); changed.specialties = changed.specialty; }
      if (Object.hasOwn(changed, 'timeZone')) changed.timezone = changed.timeZone;
      const stamp = new Date(this.now()).toISOString(), next = { ...member, ...changed, revision: (member.revision || 1) + 1, updatedAt: stamp };
      this.repo.put('members', next);
      this.identity.audit('member.profile.self_edit', actor.id, { memberId: actor.memberId,
        fields: EDITABLE_PROFILE_FIELDS.filter(key => Object.hasOwn(input, key)), operationId, revision: next.revision });
      const operationReceipt = { operationId, committedAt: stamp, revision: next.revision, result: 'committed' };
      this.repo.put('v2MemberProfileReceipts', { id: key, actorAccountId: actor.id, memberId: actor.memberId, commandHash, operationReceipt });
      return { operationReceipt, current: this.me(actor), replayed: false };
    });
  }
  signup(wipe, memberId) {
    const s = this.scheduling.signup(wipe, memberId);
    return Object.fromEntries(['wipeId', 'memberId', 'response', 'signupRevision', 'confirmedContentRevision', 'expectedArrivalAt',
      'timeZone', 'updatedAt', 'needsReconfirmation', 'confirmedMusterAt'].map(key => [key, s[key] ?? null]));
  }
  wipe(wipe, memberId, actor) {
    return { id: wipe.id, title: wipe.title, lifecycle: wipe.lifecycle, outcome: wipe.outcome || null,
      serverSnapshot: { name: typeof wipe.serverSnapshot?.name === 'string' ? wipe.serverSnapshot.name : '' },
      musterAt: wipe.musterAt, serverScheduledWipeAt: wipe.serverScheduledWipeAt || null, signupClosesAt: wipe.signupClosesAt,
      timeZone: wipe.timeZone, revision: wipe.revision, contentRevision: wipe.contentRevision,
      effectiveSignupWindow: this.scheduling.window(wipe),
      mySignup: can(actor, 'signups.read', { kind: 'signup', wipeId: wipe.id, memberId }, this.relations([memberId], wipe)) ? this.signup(wipe, memberId) : null };
  }
  teamSummary(actor) {
    if (!actor.memberId) return null;
    const team = this.repo.team(actor.memberId);
    if (!team || !can(actor, 'squads.read', { kind: 'squad', id: team.id }, this.relations([actor.memberId]))) return null;
    return { id: team.id, name: team.name || team.displayName || '我的队伍' };
  }
  teamDirectoryAllowed(actor, team, relations) {
    const resource = { kind: 'squad', id: team.id };
    return can(actor, 'members.directory', resource, relations) && !actor.grants.some(grant =>
      grant.capability === 'squads.read' && grant.effect === 'deny' && validGrant(grant) &&
      scopeMatches(grant.scope, actor, resource, relations, 'deny', 'squads.read'));
  }
  home(input) {
    const actor = this.actor(input); this.requireMember(actor);
    const next = this.repo.nextWipe(actor, this.now()), wipe = next ? this.wipe(next, actor.memberId, actor) : null;
    let participation = this.participation(actor);
    if (wipe && (!wipe.mySignup || !can(actor, 'signups.self_write', { kind: 'signup', wipeId: wipe.id, memberId: actor.memberId }, this.relations([actor.memberId], next))))
      participation = { canSignup: false, reasonCode: 'ACCESS_DENIED' };
    const href = wipe ? `/app/wipes/${encodeURIComponent(wipe.id)}` : '/app/team';
    const kind = !wipe ? 'view_team' : !participation.canSignup || wipe.effectiveSignupWindow !== 'open' ? 'view_wipe' :
      wipe.mySignup.response ? 'edit_signup' : 'signup';
    const todos = !wipe || !participation.canSignup || wipe.effectiveSignupWindow !== 'open' ? [] :
      !wipe.mySignup.response ? [{ kind: 'signup', wipeId: wipe.id, href }] : [];
    return { nextWipe: wipe, nextAction: { kind, href, labelKey: `member.action.${kind}` }, todos,
      participation, team: this.teamSummary(actor), historyHref: '/app/history', evaluatedAt: new Date(this.now()).toISOString() };
  }
  page(input, actor, filter) {
    const limit = Math.min(50, Math.max(1, Number.parseInt(input.limit, 10) || 20)), scope = this.repo.rosterRevision();
    let after = '';
    if (input.cursor) {
      try {
        need(typeof input.cursor === 'string' && input.cursor.length < 2000, 'CURSOR_EXPIRED', 410);
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        need(cursor.schema === 1 && cursor.accountId === actor.id && cursor.scopeVersion === actor.permissionVersion && cursor.rosterRevision === scope &&
          cursor.filterHash === hash(filter) && Number.isFinite(cursor.expiresAt) && cursor.expiresAt > this.now() &&
          cursor.sort === filter.sort && typeof cursor.after === 'string' && cursor.after.length <= 400, 'CURSOR_EXPIRED', 410);
        after = cursor.after;
        if (filter.route === 'history') {
          const tail = JSON.parse(after);
          need(tail && typeof tail.id === 'string' && tail.id.length <= 200 && typeof tail.updatedAt === 'string' && tail.updatedAt.length <= 40, 'CURSOR_EXPIRED', 410);
        }
      } catch { throw new IdentityError('CURSOR_EXPIRED', 410); }
    }
    return { limit, after, cursor: after => Buffer.from(JSON.stringify({ schema: 1, accountId: actor.id, scopeVersion: actor.permissionVersion,
      rosterRevision: scope, filterHash: hash(filter), sort: filter.sort, after, expiresAt: this.now() + 300_000 })).toString('base64url') };
  }
  team(input, query = {}) {
    const actor = this.actor(input); this.requireMember(actor);
    const relations = this.relations([actor.memberId]);
    const teams = this.repo.teams().filter(team => this.teamDirectoryAllowed(actor, team, relations));
    const ownTeamId = this.teamSummary(actor)?.id;
    const requestedTeamId = clean(query.teamId);
    if (requestedTeamId) need(teams.some(team => team.id === requestedTeamId), 'RESOURCE_NOT_FOUND', 404);
    const team = teams.find(row => row.id === (requestedTeamId || ownTeamId)) || teams[0] || null;
    const page = this.page(query, actor, { route: 'team', teamId: team?.id || null, sort: 'id' });
    if (!team) return { team: null, teams, items: [], nextCursor: null, countScope: 'authorized_members' };
    // SQL applies scope before LIMIT; the shared resolver verifies each projected result.
    const rows = this.repo.teamMembers(actor, team.id, page.after, page.limit + 1), selected = rows.slice(0, page.limit);
    const memberRelations = this.relations([actor.memberId, ...selected.map(m => m.id)]);
    const visible = selected.filter(member => can(actor, 'members.directory', { kind: 'member', id: member.id }, memberRelations));
    const details = this.repo.teamPlatformDetails(visible.map(member => member.id));
    const steamProfiles = this.repo.teamSteamProfiles(visible.map(member => member.id));
    const items = visible.map(member => {
      const steamProfile = steamProfiles.find(row => row.memberId === member.id);
      const linked = provider => details.identities.filter(row => row.memberId === member.id && row.provider === provider)
        .sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)))[0];
      const community = provider => {
        const identity = linked(provider), aliases = provider === 'kook'
          ? [member.kookId, member.kookUserId, member.kookAccountId] : [member.discordId, member.discordUserId];
        const matched = identity && aliases.some(id => id && String(id) === identity.externalId);
        const legacyAvatar = matched ? member[`${provider}Avatar`] || member[`${provider}AvatarUrl`] : '';
        const discordHash = matched && provider === 'discord' && /^\d{15,22}$/.test(identity.externalId) &&
          /^(?:a_)?[a-f0-9]{32}$/.test(member.discordAvatarHash || '')
          ? `https://cdn.discordapp.com/avatars/${identity.externalId}/${member.discordAvatarHash}.png?size=128` : '';
        return { connected: Boolean(identity), displayName: identity ? clean(identity.displayName) ||
          (matched ? clean(member[`${provider}Name`]) : '') : '',
          avatar: platformAvatar(identity?.avatarUrl, provider) || platformAvatar(legacyAvatar, provider) ||
            platformAvatar(discordHash, provider) };
      };
      const wechatIdentity = details.identities.filter(row => row.memberId === member.id && row.provider?.startsWith('wechat:'))
        .sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)))[0];
      const wechatUser = wechatIdentity && details.wechatUsers.find(row => row.memberId === member.id &&
        row.appId === wechatIdentity.provider.slice(7) && row.openid === wechatIdentity.externalId);
      const wechatAvatar = wechatUser?.avatarUploadId?.startsWith('v2_avatar_') &&
        wechatUser.avatarUrl === `/api/v2/platform-media/avatar-image?memberId=${encodeURIComponent(member.id)}`
        ? `/api/v2/me/team/avatar/${encodeURIComponent(member.id)}` : '';
      const platforms = { kook: community('kook'), discord: community('discord'),
        wechat: { connected: Boolean(wechatIdentity), displayName: clean(wechatUser?.nickname), avatar: wechatAvatar } };
      return { ...memberDTO(member), specialty: this.profile(member).specialty,
        avatar: this.profile(member).avatar || clean(steamProfile?.avatar), steamNickname: clean(member.steamNickname) || clean(steamProfile?.displayName), steamId: clean(member.steamId),
        discordName: platforms.discord.displayName, kookName: platforms.kook.displayName, platforms, team: { ...team } };
    });
    return { team, teams, items, nextCursor: rows.length > page.limit ? page.cursor(selected.at(-1).id) : null, countScope: 'authorized_members' };
  }
  teamAvatar(input, memberId) {
    const actor = this.actor(input); this.requireMember(actor);
    need(typeof memberId === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(memberId), 'RESOURCE_NOT_FOUND', 404);
    const targetTeam = this.repo.team(memberId);
    need(targetTeam, 'RESOURCE_NOT_FOUND', 404);
    need(this.teamDirectoryAllowed(actor, targetTeam, this.relations([actor.memberId, memberId])), 'RESOURCE_NOT_FOUND', 404);
    authorize(actor, 'members.directory', { kind: 'member', id: memberId }, this.relations([actor.memberId, memberId]), true);
    const details = this.repo.teamPlatformDetails([memberId]);
    const identity = details.identities.find(row => row.memberId === memberId && row.provider?.startsWith('wechat:'));
    const appId = identity?.provider.slice(7), user = details.wechatUsers.find(row => row.memberId === memberId &&
      row.appId === appId && row.openid === identity?.externalId);
    need(user?.avatarUploadId?.startsWith('v2_avatar_') &&
      user.avatarUrl === `/api/v2/platform-media/avatar-image?memberId=${encodeURIComponent(memberId)}`, 'RESOURCE_NOT_FOUND', 404);
    const media = new PlatformMediaRepository(this.repo.db), upload = media.get('uploads', user.avatarUploadId);
    need(upload?.storage === 'v2_platform_media' && upload.appId === appId && upload.ownerType === 'wechat_user' &&
      upload.ownerId === user.id && upload.revision === user.avatarRevision && upload.url === user.avatarUrl, 'RESOURCE_NOT_FOUND', 404);
    const image = media.blob(digest([appId, upload.ownerId]));
    need(image && image.user_id === user.id && image.app_id === appId && image.revision === upload.revision && image.sha256 === upload.sha256 &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(image.content_type), 'RESOURCE_NOT_FOUND', 404);
    return { contentType: image.content_type, bytes: Buffer.from(image.bytes) };
  }
  history(input, query = {}) {
    const actor = this.actor(input); this.requireMember(actor, 'stats.read');
    const page = this.page(query, actor, { route: 'history', memberId: actor.memberId, sort: 'updatedAt_desc,id_desc' });
    const rows = this.repo.history(actor, page.after, page.limit + 1), selected = rows.slice(0, page.limit);
    const items = selected.filter(row => can(actor, 'signups.read', { kind: 'signup', wipeId: row.wipe.id, memberId: actor.memberId },
      this.relations([actor.memberId], row.wipe))).map(row => ({ wipe: this.wipe(row.wipe, actor.memberId, actor), mySignup: this.signup(row.wipe, actor.memberId),
        stats: { status: 'pending_sync', reasonCode: 'MEMBER_STATS_NOT_CONNECTED', data: null } }));
    const tail = selected.at(-1)?.signup;
    return { items, nextCursor: rows.length > page.limit ? page.cursor(JSON.stringify({ id: tail.id, updatedAt: tail.updatedAt || '' })) : null, countScope: 'self',
      stats: { status: 'pending_sync', reasonCode: 'MEMBER_STATS_NOT_CONNECTED', data: null } };
  }
}
