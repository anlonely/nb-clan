import { randomUUID } from 'node:crypto';
import { authorize, grant } from '../../identity/permissions.js';
import { memberFields, text, steamId as parseSteamId } from '../../member-admin/model.js';
import { requireValue as need } from '../../member-admin/repository.js';

const receipt = r => ({ operationId: r.operationId, ...r.data, replayed: r.replayed,
  operationReceipt: { operationId: r.operationId, committed: true, revision: r.revision } });
const platformResult = r => ({ schema: 'platform-result/1', state: 'succeeded', reference: r.operationId,
  items: [{ id: r.data.memberId || r.data.id, label: '成员操作已保存', status: 'succeeded' }] });
const check = args => {
  need(typeof args.assertCurrent === 'function', 'MEMBER_AUTHENTICATED_CONTEXT_REQUIRED', 503);
  args.assertCurrent();
  need(!Object.hasOwn(args.input, 'actor') && !Object.hasOwn(args.input, 'accountId'), 'CLIENT_ACTOR_FORBIDDEN', 403);
};

export function createMemberServiceBridges({ memberService: service, writeDomain }) {
  need(service?.identity?.repo?.db && typeof writeDomain === 'function', 'MEMBER_HOST_REQUIRED', 503);
  const run = (args, fn, project = receipt) => {
    check(args);
    return writeDomain(() => { check(args); service.fresh(args.actor); return fn(); },
      { identity: service.identity, actor: args.actor, expectedIdentityFingerprint: args.input.expectedIdentityFingerprint }).then(project);
  };
  const unbind = (args, project) => run(args, () => service.unlink(args.actor, args.input.memberId,
    { expectedRevision: args.platform ? args.input.expectedMemberRevision : args.input.expectedRevision,
      provider: args.input.provider, reason: args.input.reason, expectedIdentityFingerprint: args.input.expectedIdentityFingerprint,
      source: args.source || args.platform }, args.operationId), project);
  const updateVip = args => run(args, () => {
    const { actor, input, operationId, source } = args;
    need(['discord', 'kook'].includes(source), 'VIP_PLATFORM_CONTEXT_REQUIRED', 403);
    const provider = input.provider === 'rustintiy' ? 'rustinity' : input.provider;
    need(['vital', 'rustinity', 'atlas'].includes(provider), 'INVALID_VIP_PROVIDER', 422);
    const raw = String(input.type || '').trim().toLowerCase();
    const type = ['免排队', '免', 'queue skip', 'queueskip', 'skip queue', 'skip'].includes(raw) ? 'queue_skip' :
      ['优先队列', '优先', 'priority queue', 'vip'].includes(raw) ? 'priority' : raw;
    const fields = { [provider + 'VipType']: type,
      ...(input.purchasedAt !== undefined ? { [provider + 'VipPurchasedAt']: input.purchasedAt } : {}),
      ...(input.expiresAt !== undefined ? { [provider + 'VipExpiresAt']: input.expiresAt } : {}) };
    const allowed = ['memberId', 'provider', 'type', 'purchasedAt', 'expiresAt', 'expectedRevision'];
    need(Object.keys(input).every(k => allowed.includes(k)), 'FIELD_NOT_WRITABLE', 422);
    return service.write(actor, operationId, 'member.vip.self', { ...input, source }, a => {
      service.identity.assertMemberParticipation(a);
      need(a.memberId === input.memberId, 'ACCESS_DENIED', 403);
      // A narrowly scoped self-VIP exception cannot defeat an explicit deny.
      authorize({ ...a, grants: [...a.grants, grant('members.basic_edit', { type: 'self' })] },
        'members.basic_edit', { kind: 'member', id: a.memberId }, service.identity.relations());
      need(service.identity.repo.all('identities').some(i => i.accountId === a.id && i.provider === source), 'IDENTITY_BINDING_REQUIRED', 403);
    }, tx => {
      const m = service.repo.get('members', input.memberId);
      service.checkRevision(m, input.expectedRevision);
      need(!m.deletedAt, 'MEMBER_DELETED', 409);
      const next = tx.put('members', service.bump(m, memberFields(fields, m), tx.stamp));
      tx.history('member', m.id, { provider, selfVip: true, source, fields: Object.keys(fields) }, m.id);
      tx.event('member.profile', [m.id]);
      return { id: m.id, revision: next.revision };
    });
  });
  return {
    platform: { members: { unbind: a => unbind(a, platformResult) } },
    mini: { members: { unbind: a => unbind(a, receipt),
      list: ({ actor, input }) => service.members(actor, input) } },
    community: { members: { updateVip } }
  };
}

export function createRealtimeMemberAdapter({ memberService: service, realtimeService: realtime, writeDomain }) {
  need(realtime?.identity === service?.identity && realtime.repo.db === service.repo.db,
    'MEMBER_RUNTIME_IDENTITY_MISMATCH', 503);
  return {
    async importMember(args) {
      const { actor, source, steamId, squadId, expectedRevision, operationId } = args;
      need(source && typeof source.scopeId === 'string', 'REALTIME_SCOPE_REQUIRED', 422);
      const command = { source: { scopeId: source.scopeId, sourceId: source.sourceId, serverKey: source.serverKey },
        steamId, squadId, expectedRevision };
      const result = await writeDomain(() => service.write(actor, operationId, 'member.realtime.import', command, a => {
        const { s } = realtime.access(a, source.scopeId);
        need(realtime.allowed(a, s, 'import-member'), 'ACCESS_DENIED', 403);
        need(s.source === source.sourceId && s.server === source.serverKey, 'REALTIME_SCOPE_CHANGED', 409);
        service.global(a, 'members.basic_edit');
        need(!service.squad(a, squadId, 'squads.manage').archivedAt, 'SQUAD_ARCHIVED', 409);
        authorize(a, 'members.basic_edit', { kind: 'squad', id: squadId }, service.identity.relations());
      }, tx => {
        const s = realtime.repo.scope(source.scopeId);
        need(expectedRevision === s.revision, 'REVISION_CONFLICT', 409);
        need(realtime.status(s) === 'fresh', 'REALTIME_OBSERVATION_EXPIRED', 409);
        need(source.observedAt === s.observed, 'REALTIME_OBSERVATION_CHANGED', 409);
        const observed = s.snapshot?.members.filter(m => m.steamId === steamId);
        need(observed?.length === 1, 'RESOURCE_NOT_FOUND', 404);
        parseSteamId(steamId);
        need(!service.repo.find('members', 'steamId', steamId, 2).length, 'MEMBER_EXISTS', 409);
        // MemberAdminService.write owns all writes/receipts here. Its transaction
        // uses BEGIN, so invoking create() recursively would not be atomic.
        const member = tx.put('members', { id: `member_${randomUUID()}`, steamId, rawInput: steamId,
          steamNickname: '', customName: text(observed[0].displayName || '', 160),
          memberStatus: 'active', membershipStatus: 'active', specialty: [], revision: 1,
          invitedByUserId: tx.actor.id, createdAt: tx.stamp, updatedAt: tx.stamp });
        service.assign(tx, member, squadId);
        tx.event('member.created', [member.id], [squadId]);
        tx.history('member', member.id, { source: command.source, observedAt: s.observed,
          observationRevision: expectedRevision }, member.id);
        return { memberId: member.id, memberRevision: member.revision, observationRevision: expectedRevision };
      }), { identity: service.identity, actor });
      return { ...receipt(result), current: service.detail(service.fresh(actor), result.data.memberId) };
    }
  };
}
