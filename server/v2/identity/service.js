import { accountReadScope } from './read-snapshot.js';
import { randomUUID } from 'node:crypto';
import { digest, randomToken } from './contexts.js';
import { IdentityError, requireValue } from './errors.js';
import { authorize, can, memberDTO, validGrant, MEMBER_GRANTS, accountRole, roleGrants } from './permissions.js';
import { platformAliases, legacyBlocked, legacyFingerprint, membershipStatus } from './migration.js';
import { applyRoleMappings, applyVerifiedSystemRole } from './role-mappings.js';

const stamp = now => new Date(now()).toISOString();
const id = prefix => `${prefix}_${randomUUID()}`;
export class IdentityService {
  constructor(repo, { providers, origin = '', now = Date.now, eligibilityTtl = 300_000, ownerPasswordLogin = false, notify = () => {} } = {}) {
    this.repo = repo; this.providers = providers; this.origin = origin; this.now = now; this.eligibilityTtl = eligibilityTtl; this.notify = notify;
    this.ownerPasswordLogin = ownerPasswordLogin;
    this.listeners = new Set();
  }
  audit(action, accountId, detail = {}) {
    this.repo.put('audits', { id: id('audit'), action, accountId, ...detail, createdAt: stamp(this.now) });
  }
  event(accountId, reason) {
    const event = this.repo.put('events', { id: id('event'), accountId, reason, createdAt: stamp(this.now) });
    return event;
  }
  publish(events) { for (const event of events) { this.notify(event); for (const listener of this.listeners) listener(event); } }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  policy(provider) {
    const policy = this.repo.all('policies').find(p => p.provider === provider);
    requireValue(policy?.enabled && policy.guildId && policy.allowedRoleIds?.length, 'LOGIN_UNAVAILABLE', 503);
    return policy;
  }
  async checkEligibility(provider, externalId, { includeCommunity = false } = {}) {
    const policy = this.policy(provider);
    const key = digest(`${provider}:${externalId}:${policy.id}`);
    let result;
    try {
      result = await this.providers[provider].roles(externalId, policy.guildId, { includeCommunity });
      requireValue(result?.externalId === externalId && result.guildId === policy.guildId && Array.isArray(result.roleIds) &&
        result.roleIds.every(value => typeof value === 'string'), 'ELIGIBILITY_UNAVAILABLE', 503);
    } catch (error) {
      if (provider === 'kook' && ['KOOK_RATE_LIMITED', 'KOOK_BUSY'].includes(error?.errorCode)) throw error;
      result = { unavailable: true };
      if (error.errorCode === 'ELIGIBILITY_DENIED') result = { roleIds: [] };
    }
    const allowed = new Set(result.roleIds || []);
    const eligible = policy.matchMode === 'all' ? policy.allowedRoleIds.every(role => allowed.has(role)) : policy.allowedRoleIds.some(role => allowed.has(role));
    const status = result.unavailable ? 'unknown' : eligible ? 'eligible' : 'ineligible';
    // Community names/icons are display metadata. A normal role refresh must
    // neither erase them nor make their original observation time look fresh.
    const previous = this.repo.get('eligibility', key);
    const sameCommunity = previous?.provider === provider && previous.externalId === externalId &&
      previous.guildId === policy.guildId && previous.policyRevision === policy.policyRevision;
    const freshCommunity = includeCommunity && result.community?.available === true;
    const community = freshCommunity ? result.community : sameCommunity ? previous.community : null;
    const communityCheckedAt = freshCommunity ? stamp(this.now) : community ? previous.communityCheckedAt || previous.checkedAt : null;
    const evidence = { id: key, provider, externalId, policyId: policy.id, policyRevision: policy.policyRevision,
      roleIds: result.roleIds || [],
      guildId: policy.guildId, status, reasonCode: status === 'eligible' ? 'ROLE_MATCHED' : status === 'unknown' ? 'ELIGIBILITY_UNAVAILABLE' : 'ELIGIBILITY_DENIED',
      ...(community ? { community: { ...community, displayOnly: !freshCommunity, roles: (community.roles || []).filter(role => allowed.has(String(role.id))) }, communityCheckedAt } :
        includeCommunity ? { community: result.community || null, communityCheckedAt: null } : {}),
      checkedAt: stamp(this.now), expiresAt: new Date(this.now() + this.eligibilityTtl).toISOString() };
    this.repo.transaction(() => {
      const current = this.policy(provider);
      requireValue(current.policyRevision === policy.policyRevision, 'ELIGIBILITY_CHANGED', 409);
      this.repo.put('eligibility', evidence);
    });
    if (status !== 'eligible') throw new IdentityError(evidence.reasonCode, status === 'unknown' ? 503 : 403);
    return evidence;
  }
  assertEvidence(evidence, provider, externalId) {
    const policy = this.policy(provider);
    const current = evidence && this.repo.get('eligibility', evidence.id);
    requireValue(current && current.provider === provider && current.externalId === externalId && current.status === 'eligible' &&
      current.policyRevision === policy.policyRevision && current.checkedAt === evidence.checkedAt &&
      Date.parse(current.expiresAt) > this.now(), 'ELIGIBILITY_CHANGED', 409);
    return policy;
  }
  aliases(provider, externalId, steamId) {
    const members = this.repo.all('members'), users = this.repo.all('users');
    const ownMembers = members.filter(m => platformAliases(m, provider).includes(externalId));
    const steamMembers = steamId ? members.filter(m => m.steamId === steamId) : [];
    const ownUsers = users.filter(u => platformAliases(u, provider).includes(externalId));
    const steamUsers = steamId ? users.filter(u => u.boundSteamId === steamId) : [];
    requireValue(ownMembers.length <= 1 && steamMembers.length <= 1 && ownUsers.length <= 1 && steamUsers.length <= 1,
      'IDENTITY_CONFLICT', 409);
    // A Discord-created, unverified roster member must never be silently merged
    // into a different member selected by a subsequently proved Steam identity.
    requireValue(!ownMembers[0] || !steamMembers[0] || ownMembers[0].id === steamMembers[0].id,
      'IDENTITY_CONFLICT', 409);
    requireValue([...ownMembers, ...steamMembers, ...ownUsers, ...steamUsers].every(r =>
      platformAliases(r, provider).every(value => value === externalId)), 'IDENTITY_CONFLICT', 409);
    if (steamId) requireValue(ownMembers.every(m => !m.steamId || m.steamId === steamId) &&
      ownUsers.every(u => !u.boundSteamId || u.boundSteamId === steamId), 'IDENTITY_CONFLICT', 409);
    return { member: steamMembers[0] || ownMembers[0], user: steamUsers[0] || ownUsers[0] };
  }
  identity(provider, externalId) { return this.repo.all('identities').find(i => i.provider === provider && i.externalId === externalId); }
  recordConflict(provider, externalId, accountId, code = 'IDENTITY_CONFLICT') {
    this.repo.transaction(() => this.repo.put('conflicts', { id: id('conflict'), kind: code, provider,
      externalId, accountId: accountId || null, status: 'open', createdAt: stamp(this.now), revision: 1 }));
  }
  accountAccess(account, { onboarding = false } = {}) {
    requireValue(account, 'AUTH_REQUIRED', 401);
    requireValue(account.status === 'active', 'ACCOUNT_DISABLED');
    requireValue(!account.roleAccessLock, 'MEMBER_DEPARTED');
    const legacy = account.legacyUserId && this.repo.get('users', account.legacyUserId);
    if (account.legacyUserId) {
      requireValue(legacy && !legacy.disabled && legacy.status !== 'disabled', 'ACCOUNT_DISABLED');
      requireValue(account.legacyFingerprint === legacyFingerprint(legacy, this.repo.all('permissionRoles')), 'PERMISSIONS_CHANGED', 401);
    }
    const member = account.memberId && this.repo.get('members', account.memberId);
    requireValue(!account.memberId || member, 'IDENTITY_CONFLICT', 409);
    const verifiedBinding = this.repo.all('bindings').find(b => b.accountId === account.id && b.status === 'verified');
    requireValue(!verifiedBinding || verifiedBinding.memberId === account.memberId && member?.steamId === verifiedBinding.steamId,
      'IDENTITY_CONFLICT', 409);
    const restrictions = this.repo.all('restrictions').filter(r => (r.accountId === account.id || member && r.memberId === member.id) &&
      Date.parse(r.startsAt) <= this.now() && (!r.endsAt || Date.parse(r.endsAt) > this.now()));
    requireValue(!restrictions.length && !legacyBlocked(member), 'ACCESS_RESTRICTED');
    if (member && !onboarding) requireValue(['active', 'paused'].includes(membershipStatus(member)), 'MEMBERSHIP_INACTIVE');
    return member;
  }
  knownAccount(profile) {
    this.aliases(profile.provider, profile.id);
    const identity = this.identity(profile.provider, profile.id);
    return identity && this.repo.get('accounts', identity.accountId);
  }
  login(profile, evidence) {
    return this.repo.transaction(() => {
      this.assertEvidence(evidence, profile.provider, profile.id);
      evidence = this.repo.get('eligibility', evidence.id);
      const account = this.knownAccount(profile);
      if (!account) return { step: 'steam', accountId: null, expectedRevision: null };
      this.accountAccess(account, { onboarding: true });
      const binding = this.repo.all('bindings').find(b => b.accountId === account.id && b.status === 'verified');
      if (!binding) return { step: 'steam', accountId: account.id, expectedRevision: account.revision };
      const aliases = this.aliases(profile.provider, profile.id, binding.steamId);
      requireValue(!aliases.member || aliases.member.id === account.memberId, 'IDENTITY_CONFLICT', 409);
      this.accountAccess(account);
      const identity = this.identity(profile.provider, profile.id);
      this.repo.put('identities', { ...identity, displayName: profile.displayName || identity.displayName || '',
        avatarUrl: profile.avatarUrl || identity.avatarUrl || '',
        verifiedAt: stamp(this.now), revision: identity.revision + 1 });
      applyRoleMappings(this.repo, this.repo.get('members', account.memberId), account, evidence, this.now);
      return { step: 'complete', ...this.issueSession(this.repo.get('accounts', account.id), evidence) };
    });
  }
  steamLoginEnabled() { return this.repo.scalar('settings')?.thirdPartyLogin?.steam?.enabled !== false; }
  // Steam proves an existing member; it never registers a new member or grants management access.
  steamLoginAccount(steamId, context = {}) {
    requireValue(this.steamLoginEnabled(), 'LOGIN_UNAVAILABLE', 503);
    requireValue(typeof steamId === 'string' && /^7656\d{13}$/.test(steamId), 'AUTH_INVALID_CALLBACK', 401);
    const bindings = this.repo.all('bindings'), matches = bindings.filter(b => b.steamId === steamId);
    const members = this.repo.all('members').filter(m => m.steamId === steamId);
    const allUsers = this.repo.all('users'), users = allUsers.filter(u => u.boundSteamId === steamId);
    requireValue(matches.length, 'PLATFORM_LOGIN_REQUIRED', 403);
    requireValue(matches.length === 1, 'IDENTITY_CONFLICT', 409);
    const binding = matches[0], account = this.repo.get('accounts', binding.accountId);
    requireValue(['verified', 'legacy_unverified'].includes(binding.status) && binding.proofSource !== 'legacy_conflict', 'IDENTITY_CONFLICT', 409);
    const member = this.accountAccess(account);
    requireValue(member && member.id === binding.memberId && members.length === 1 && members[0].id === member.id &&
      users.length <= 1 && (!users.length || users[0].id === account.legacyUserId) &&
      bindings.filter(b => b.accountId === account.id || b.memberId === member.id).length === 1, 'IDENTITY_CONFLICT', 409);
    if (context.accountId) requireValue(context.accountId === account.id && context.expectedRevision === account.revision, 'IDENTITY_CONFLICT', 409);
    const identities = this.repo.all('identities').filter(i => i.accountId === account.id && ['discord', 'kook'].includes(i.provider));
    requireValue(identities.length, 'PLATFORM_LOGIN_REQUIRED', 403);
    for (const provider of ['discord', 'kook']) {
      const linked = identities.filter(i => i.provider === provider);
      const aliases = [...new Set([member, ...users].flatMap(r => platformAliases(r, provider)))];
      requireValue(linked.length <= 1 && aliases.every(value => linked[0]?.externalId === value), 'IDENTITY_CONFLICT', 409);
      if (linked.length) {
        const known = this.aliases(provider, linked[0].externalId, steamId);
        requireValue(!known.member || known.member.id === member.id, 'IDENTITY_CONFLICT', 409);
      }
    }
    return { account, binding, member, identities };
  }
  async steamLoginEvidence(candidate) {
    let failure;
    for (const identity of candidate.identities) {
      try { return await this.checkEligibility(identity.provider, identity.externalId, { includeCommunity: true }); }
      catch (error) {
        if (!(error instanceof IdentityError)) throw error;
        failure = error;
      }
    }
    if (failure) throw failure;
    throw new IdentityError('PLATFORM_LOGIN_REQUIRED', 403);
  }
  completeSteamLogin(steamId, candidate, evidence, context) {
    return this.repo.transaction(() => {
      const current = this.steamLoginAccount(steamId, context);
      requireValue(current.account?.id === candidate.account?.id && current.account?.revision === candidate.account?.revision &&
        current.binding?.id === candidate.binding?.id && current.binding?.revision === candidate.binding?.revision &&
        current.member.id === candidate.member.id && current.member.revision === candidate.member.revision &&
        JSON.stringify(current.identities) === JSON.stringify(candidate.identities), 'IDENTITY_CONFLICT', 409);
      requireValue(current.identities.some(i => i.provider === evidence?.provider && i.externalId === evidence?.externalId), 'ELIGIBILITY_CHANGED', 409);
      this.assertEvidence(evidence, evidence.provider, evidence.externalId);
      evidence = this.repo.get('eligibility', evidence.id);
      if (current.binding.status === 'legacy_unverified') {
        this.repo.put('bindings', { ...current.binding, status: 'verified', verifiedAt: stamp(this.now),
          proofSource: `${evidence.provider}_steam_openid`, revision: current.binding.revision + 1 });
        this.audit('steam_bound', current.account.id, { memberId: current.binding.memberId, provider: 'steam' });
      }
      applyRoleMappings(this.repo, current.member, current.account, evidence, this.now);
      return this.issueSession(this.repo.get('accounts', current.account.id), evidence);
    });
  }
  bind(profile, steamId, evidence, context) {
    requireValue(/^7656\d{13}$/.test(steamId), 'AUTH_INVALID_CALLBACK', 401);
    try {
      return this.repo.transaction(() => {
        this.assertEvidence(evidence, profile.provider, profile.id);
        evidence = this.repo.get('eligibility', evidence.id);
        const identity = this.identity(profile.provider, profile.id);
        const aliases = this.aliases(profile.provider, profile.id, steamId);
        const bindings = this.repo.all('bindings');
        const bound = bindings.filter(b => b.status === 'verified' && b.steamId === steamId);
        const candidateIds = new Set([identity?.accountId, context.accountId, bound[0]?.accountId,
          aliases.user?.id, ...this.repo.all('accounts').filter(a => aliases.member && a.memberId === aliases.member.id).map(a => a.id)].filter(Boolean));
        requireValue(candidateIds.size <= 1, 'IDENTITY_CONFLICT', 409);
        let account = candidateIds.size ? this.repo.get('accounts', [...candidateIds][0]) : null;
        requireValue(!candidateIds.size || account, 'IDENTITY_CONFLICT', 409);
        if (context.accountId) requireValue(account?.id === context.accountId && account.revision === context.expectedRevision, 'IDENTITY_CONFLICT', 409);
        if (account) this.accountAccess(account, { onboarding: true });
        const member = aliases.member || account?.memberId && this.repo.get('members', account.memberId);
        requireValue(!member || !member.steamId || member.steamId === steamId, 'IDENTITY_CONFLICT', 409);
        requireValue(!member || !legacyBlocked(member) && ['active', 'paused'].includes(membershipStatus(member)), 'ACCESS_RESTRICTED');
        requireValue(!account?.memberId || !member || account.memberId === member.id, 'IDENTITY_CONFLICT', 409);
        // A revoked binding or a different historical Steam owner requires an explicit reviewed change.
        if (account) requireValue(!bindings.some(b => b.accountId === account.id && (b.status === 'revoked' || b.steamId !== steamId)), 'IDENTITY_CONFLICT', 409);
        const nextMember = member ? !member.steamId ? { ...member, steamId,
          revision: (member.revision || 1) + 1, updatedAt: stamp(this.now) } : member : { id: id('member'), steamId, displayName: profile.displayName || '',
          customName: profile.displayName || '', steamNickname: '', memberStatus: 'active', membershipStatus: 'active',
          specialty: [], createdAt: stamp(this.now), revision: 1 };
        if (!member || !member.steamId) this.repo.put('members', nextMember);
        if (!account) account = { id: id('account'), memberId: nextMember.id, status: 'active', roleId: 'member',
          grants: structuredClone(MEMBER_GRANTS), permissionVersion: 1, revision: 1, createdAt: stamp(this.now) };
        else account = { ...account, memberId: nextMember.id, revision: account.revision + 1 };
        this.repo.put('accounts', account);
        this.repo.put('identities', { ...(identity || { id: id('identity') }), accountId: account.id,
          provider: profile.provider, externalId: profile.id, displayName: profile.displayName || identity?.displayName || '',
          avatarUrl: profile.avatarUrl || identity?.avatarUrl || '',
          verifiedAt: stamp(this.now), revision: (identity?.revision || 0) + 1 });
        const prior = bindings.find(b => b.accountId === account.id && b.steamId === steamId && b.status !== 'revoked');
        this.repo.put('bindings', { id: prior?.id || id('binding'), accountId: account.id, memberId: nextMember.id,
          steamId, status: 'verified', verifiedAt: stamp(this.now), proofSource: `${profile.provider}_steam_openid`, revision: (prior?.revision || 0) + 1 });
        applyRoleMappings(this.repo, nextMember, account, evidence, this.now);
        this.audit('steam_bound', account.id, { memberId: nextMember.id, provider: profile.provider });
        return this.issueSession(this.repo.get('accounts', account.id), evidence);
      });
    } catch (error) {
      if (error.errorCode === 'IDENTITY_CONFLICT' || error.code?.startsWith('SQLITE_CONSTRAINT')) {
        this.recordConflict(profile.provider, profile.id, context.accountId);
        throw new IdentityError('IDENTITY_CONFLICT', 409);
      }
      throw error;
    }
  }
  issueSession(account, evidence = null) {
    this.accountAccess(account);
    const token = randomToken(), csrfToken = randomToken();
    this.repo.put('sessions', { id: digest(token), accountId: account.id, csrfHash: digest(csrfToken),
      permissionVersion: account.permissionVersion, scopeDigest: this.scopeDigest(account), identityProvider: evidence?.provider || 'password',
      externalId: evidence?.externalId || null, eligibilityId: evidence?.id || null,
      createdAt: stamp(this.now), expiresAt: new Date(this.now() + 43_200_000).toISOString() });
    this.audit('session_created', account.id);
    return { token, csrfToken, accountId: account.id };
  }
  session(token) {
    const session = this.repo.get('sessions', digest(token));
    requireValue(session && Date.parse(session.expiresAt) > this.now(), 'AUTH_REQUIRED', 401);
    const account = this.repo.get('accounts', session.accountId);
    requireValue(account, 'AUTH_REQUIRED', 401);
    requireValue(account.status === 'active', 'ACCOUNT_DISABLED');
    requireValue(!account.roleAccessLock, 'MEMBER_DEPARTED');
    requireValue(account.permissionVersion === session.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    if (session.scopeDigest !== this.scopeDigest(account)) {
      this.revokeAccountScope(account.id, 'membership_scope_changed');
      throw new IdentityError('PERMISSIONS_CHANGED', 401);
    }
    return { session, actor: this.actorForAccount(account.id) };
  }
  // Called only after a session or platform proof was authenticated; this is not authentication.
  actorForAccount(accountId) {
    return accountReadScope(this, accountId, { actor: true }).readActorForAccount(accountId);
  }
  readActorForAccount(accountId) {
    const account = this.repo.get('accounts', accountId);
    const member = this.accountAccess(account);
    const binding = this.repo.all('bindings').find(b => b.accountId === account.id && b.status === 'verified');
    const roleId = accountRole(this.repo, account);
    const actor = { ...account, roleId, memberId: binding ? account.memberId : null, memberStatus: member && membershipStatus(member),
      grants: roleGrants(roleId) };
    return actor;
  }
  scopeDigest(account) {
    return accountReadScope(this, account).readScopeDigest(account);
  }
  readScopeDigest(account) {
    return digest(JSON.stringify({
      account: [account.memberId, account.status, account.roleId, account.adminAssignedByOwner, account.roleDerivedSystemRole,
        account.roleDerivedSystemRoles, accountRole(this.repo, account), account.grants],
      memberStatus: account.memberId ? membershipStatus(this.repo.get('members', account.memberId) || {}) : null,
      memberSteamId: account.memberId ? this.repo.get('members', account.memberId)?.steamId : null,
      legacy: account.legacyUserId ? legacyFingerprint(this.repo.get('users', account.legacyUserId), this.repo.all('permissionRoles')) : null,
      membership: this.repo.all('squadMembers').filter(s => s.memberId === account.memberId && !s.validTo),
      leadership: this.repo.all('squads').filter(s => !s.archivedAt && (s.leaderUserIds || [s.leaderUserId]).includes(account.legacyUserId || account.id)).map(s => s.id),
      binding: this.repo.all('bindings').filter(b => b.accountId === account.id).map(b => [b.id, b.status, b.steamId, b.revision])
    }));
  }
  revokeAccountScope(accountId, reason) {
    let event;
    this.repo.transaction(() => {
      const account = this.repo.get('accounts', accountId); if (!account) return;
      this.repo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1, revision: account.revision + 1 });
      for (const session of this.repo.all('sessions').filter(s => s.accountId === accountId)) this.repo.remove('sessions', session.id);
      event = this.event(accountId, reason);
    });
    if (event) this.publish([event]);
  }
  saveRestriction(actor, input) {
    let events = [];
    const result = this.repo.transaction(() => {
      authorize(actor, 'system.accounts', { kind: 'account', id: actor.id }, this.relations());
      requireValue(Boolean(input.accountId) !== Boolean(input.memberId), 'INVALID_RESTRICTION', 422);
      requireValue(input.kind === 'deny_access' && typeof input.reason === 'string' && input.reason.length > 0 && input.reason.length <= 500 &&
        Number.isFinite(Date.parse(input.startsAt)) && (!input.endsAt || Date.parse(input.endsAt) > Date.parse(input.startsAt)), 'INVALID_RESTRICTION', 422);
      requireValue(input.accountId ? this.repo.get('accounts', input.accountId) : this.repo.get('members', input.memberId), 'RESOURCE_NOT_FOUND', 404);
      const targets = this.repo.all('accounts').filter(a => a.id === input.accountId || input.memberId && a.memberId === input.memberId);
      requireValue(targets.every(a => accountRole(this.repo, a) !== 'owner' && (actor.roleId === 'owner' || accountRole(this.repo, a) === 'member')), 'PROTECTED_ACCOUNT', 403);
      const current = input.id && this.repo.get('restrictions', input.id);
      requireValue(input.expectedRevision === (current?.revision || 0), 'REVISION_CONFLICT', 409);
      requireValue(!current || current.accountId === input.accountId && current.memberId === input.memberId, 'INVALID_RESTRICTION', 422);
      const record = { id: current?.id || id('restriction'), accountId: input.accountId, memberId: input.memberId,
        kind: input.kind, reason: input.reason, startsAt: input.startsAt, endsAt: input.endsAt || null, revision: (current?.revision || 0) + 1 };
      this.repo.put('restrictions', record);
      const accounts = this.repo.all('accounts').filter(a => a.id === input.accountId || input.memberId && a.memberId === input.memberId);
      for (const account of accounts) {
        this.repo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1, revision: account.revision + 1 });
        for (const session of this.repo.all('sessions').filter(s => s.accountId === account.id)) this.repo.remove('sessions', session.id);
      }
      events = accounts.map(account => this.event(account.id, 'access_restriction_changed'));
      this.audit('access_restriction_changed', actor.id, { restrictionId: record.id });
      return record;
    });
    this.publish(events); return result;
  }
  async requireFreshEligibility(session) {
    if (this.ownerPasswordLogin && session.identityProvider === 'owner_password' && session.accountId === 'user_root') {
      const account = this.repo.get('accounts', session.accountId);
      this.accountAccess(account);
      requireValue(accountRole(this.repo, account) === 'owner', 'PLATFORM_LOGIN_REQUIRED', 403);
      return;
    }
    requireValue(['discord', 'kook'].includes(session.identityProvider), 'PLATFORM_LOGIN_REQUIRED', 403);
    const account = this.repo.get('accounts', session.accountId);
    requireValue(this.repo.all('bindings').some(b => b.accountId === account?.id && b.status === 'verified'), 'PLATFORM_LOGIN_REQUIRED', 403);
    requireValue(this.repo.all('identities').some(i => i.accountId === account.id && i.provider === session.identityProvider && i.externalId === session.externalId), 'PLATFORM_LOGIN_REQUIRED', 403);
    const policy = this.policy(session.identityProvider);
    const current = this.repo.get('eligibility', session.eligibilityId);
    if (current?.status === 'eligible' && current.policyRevision === policy.policyRevision && Date.parse(current.expiresAt) > this.now()) return;
    const evidence = await this.checkEligibility(session.identityProvider, session.externalId, { includeCommunity: true });
    this.repo.transaction(() => {
      this.assertEvidence(evidence, session.identityProvider, session.externalId);
      applyVerifiedSystemRole(this.repo, this.repo.get('accounts', session.accountId), this.repo.get('eligibility', evidence.id));
    });
  }
  relations() {
    // Once scheduling migration is complete, only V2 audience is authoritative.
    return { squadMembers: this.repo.all('squadMembers'),
      wipes: this.repo.all(this.repo.scalar('v2SchedulingMigration') ? 'schedulingWipes' : 'wipes') };
  }
  assertMemberParticipation(actor) {
    requireValue(actor.memberId && actor.memberStatus === 'active', 'MEMBERSHIP_INACTIVE');
    authorize(actor, 'signups.self_write', { kind: 'member', id: actor.memberId }, this.relations());
  }
  listMembers(actor, query = '') {
    const relations = this.relations();
    return this.repo.all('members').filter(m => can(actor, 'members.read', { kind: 'member', id: m.id }, relations))
      .map(memberDTO).filter(m => m.displayName.toLowerCase().includes(String(query).toLowerCase()));
  }
  changeAccount(actor, accountId, input) {
    const events = [];
    const result = this.repo.transaction(() => {
      authorize(actor, input.grants === undefined ? 'system.accounts' : 'system.permissions', { kind: 'account', id: accountId }, this.relations());
      const current = this.repo.get('accounts', accountId);
      requireValue(current, 'RESOURCE_NOT_FOUND', 404);
      requireValue(accountRole(this.repo, current) !== 'owner' && (actor.roleId === 'owner' || accountRole(this.repo, current) === 'member'), 'PROTECTED_ACCOUNT', 403);
      requireValue(input.grants === undefined, 'FIXED_ROLE_PERMISSIONS', 403);
      requireValue(input.expectedRevision === current.revision, 'REVISION_CONFLICT', 409);
      requireValue(input.grants === undefined || Array.isArray(input.grants) && input.grants.every(validGrant), 'INVALID_GRANTS', 422);
      requireValue(input.status === undefined || ['active', 'disabled'].includes(input.status), 'INVALID_STATUS', 422);
      const legacy = current.legacyUserId && this.repo.get('users', current.legacyUserId);
      const updated = { ...current, grants: input.grants ?? current.grants, status: input.status ?? current.status,
        ...(legacy ? { legacyFingerprint: legacyFingerprint(legacy, this.repo.all('permissionRoles')) } : {}),
        permissionVersion: current.permissionVersion + 1, revision: current.revision + 1 };
      this.repo.put('accounts', updated);
      for (const session of this.repo.all('sessions').filter(s => s.accountId === accountId)) this.repo.remove('sessions', session.id);
      this.audit('permissions_changed', actor.id, { targetAccountId: accountId });
      events.push(this.event(accountId, 'permissions_changed'));
      return updated;
    });
    this.publish(events);
    return result;
  }
  savePolicy(actor, input) {
    const events = [];
    const result = this.repo.transaction(() => {
      authorize(actor, 'platforms.configure', { kind: 'platformTarget', id: input.provider }, this.relations());
      requireValue(['discord', 'kook'].includes(input.provider) && typeof input.guildId === 'string' && input.guildId.length > 0 &&
        ['any', 'all'].includes(input.matchMode) && typeof input.enabled === 'boolean' && input.defaultRoleId === 'member' &&
        Array.isArray(input.allowedRoleIds) && input.allowedRoleIds.every(x => typeof x === 'string' && x.length > 0) &&
        (!input.enabled || input.allowedRoleIds.length > 0), 'INVALID_ELIGIBILITY_POLICY', 422);
      const current = this.repo.all('policies').find(p => p.provider === input.provider);
      requireValue(input.expectedRevision === (current?.policyRevision || 0), 'REVISION_CONFLICT', 409);
      const policy = { id: current?.id || id('policy'), provider: input.provider, guildId: input.guildId,
        allowedRoleIds: [...new Set(input.allowedRoleIds)], matchMode: input.matchMode, enabled: input.enabled,
        defaultRoleId: 'member', policyRevision: (current?.policyRevision || 0) + 1 };
      this.repo.put('policies', policy);
      for (const session of this.repo.all('sessions').filter(s => s.identityProvider === input.provider)) {
        this.repo.remove('sessions', session.id); events.push(this.event(session.accountId, 'eligibility_policy_changed'));
      }
      this.audit('eligibility_policy_changed', actor.id, { policyId: policy.id });
      return policy;
    });
    this.publish(events); return result;
  }
  invalidateEligibility(provider, externalId) {
    const events = [];
    this.repo.transaction(() => {
      for (const evidence of this.repo.all('eligibility').filter(e => e.provider === provider && e.externalId === externalId)) {
        this.repo.put('eligibility', { ...evidence, status: 'unknown', expiresAt: stamp(this.now) });
      }
      for (const session of this.repo.all('sessions').filter(s => s.identityProvider === provider && s.externalId === externalId)) {
        this.repo.remove('sessions', session.id); events.push(this.event(session.accountId, 'platform_roles_changed'));
      }
    });
    this.publish(events);
  }
  closeAccount(actor) {
    requireValue(actor.roleId !== 'owner' && actor.memberId, 'PROTECTED_ACCOUNT', 403);
    let event;
    this.repo.transaction(() => {
      const account = this.repo.get('accounts', actor.id);
      this.accountAccess(account);
      requireValue(accountRole(this.repo, account) !== 'owner', 'PROTECTED_ACCOUNT', 403);
      const at = stamp(this.now), member = this.repo.get('members', account.memberId);
      this.repo.put('accounts', { ...account, status: 'disabled', closedAt: at, permissionVersion: account.permissionVersion + 1, revision: account.revision + 1 });
      this.repo.put('members', { ...member, memberStatus: 'left', membershipStatus: 'departed', leftAt: at, revision: (member.revision || 1) + 1 });
      for (const membership of this.repo.all('squadMembers').filter(s => s.memberId === member.id && !s.validTo)) this.repo.put('squadMembers', { ...membership, validTo: at });
      for (const session of this.repo.all('sessions').filter(s => s.accountId === account.id)) this.repo.remove('sessions', session.id);
      if (account.legacyUserId) { const user = this.repo.get('users', account.legacyUserId); if (user) this.repo.put('users', { ...user, disabled: true, status: 'disabled' }); }
      this.audit('self_account_closed', account.id, { memberId: member.id });
      event = this.event(account.id, 'account_closed');
    });
    this.publish([event]);
    return { accountId: actor.id, closed: true, clearClientCache: true };
  }
  logout(token) { this.repo.transaction(() => this.repo.remove('sessions', digest(token))); }
}
