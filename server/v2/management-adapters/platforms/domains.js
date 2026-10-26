import {jobResult,rankingResult,mapResult} from '../../platform-admin/results.js';
import {communityLanguage} from '../../notification-platforms/native-language.js';
import { authorize, can } from '../../identity/permissions.js';
import { need } from '../../platform-admin/model.js';
import { createMemberServiceBridges } from '../members/index.js';
import { SystemError } from '../../system-admin/model.js';
import { IdentityError } from '../../identity/errors.js';
import { createMiniMemberViews } from './mini-members.js';
import { createMiniWipeParticipants } from './mini-wipe-participants.js';

const omit = (input, keys) => Object.fromEntries(Object.entries(input).filter(([key, value]) => !keys.includes(key) && value !== undefined));
const receipt = r => ({ operationId: r.operationId, ...r.data, revision: r.data?.revision ?? r.revision, replayed: r.replayed });

export function createPlatformDomainAdapters({ identity, scheduling, memberSpace, members, memberBundle,
  stats, sync, runStoreWriteTask, patchStoreCache, executeStatsJob, notifications, system }) {
  const bridges = createMemberServiceBridges({ memberService: members, writeDomain: memberBundle.writeDomain });
  const local = (args, fn) => runStoreWriteTask(() => { args.assertCurrent(); return fn(); });
  const memberWrite = (args, fn) => memberBundle.writeDomain(() => { args.assertCurrent(); return fn(); },
    { identity, actor: args.actor, expectedIdentityFingerprint: args.input.expectedIdentityFingerprint }).then(receipt);
  const transition = command => args => local(args, () => scheduling.transition(args.actor, args.input.wipeId, command,
    omit(args.input, ['wipeId']), { operationId: args.operationId, source: 'wechat' }));
  const signup = withdraw => async args => {
    const { actor, input, operationId } = args, options = { operationId, source: 'wechat', delegate: true };
    await scheduling.prepareSignupTarget(actor, input.wipeId, input.memberId, options);
    return local(args, () => scheduling.saveSignup(actor, input.wipeId, input.memberId,
      { ...omit(input, ['wipeId', 'memberId', 'expectedRevision']), ...(withdraw ? { response: null } : {}) }, options));
  };
  // Invocation-only view: SAME service methods, repository and queue. The shared
  // authority is never mutated; the callback fences permissionVersion exactly
  // when the original SyncCenter queue enters its transaction.
  const syncFor = args => Object.assign(Object.create(sync), { authority: { ...sync.authority,
    serializeWrite: fn => sync.authority.serializeWrite(() => { args.assertCurrent(); return fn(); }) } });
  function requestSync(args) {
    args.assertCurrent();
    const { actor, input, operationId } = args, service = syncFor(args);
    if (input.action === 'status') return service.detail(actor, input.jobId, input);
    if (input.action === 'cancel') {
      need(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, 'SYNC_EXPECTED_REVISION_REQUIRED', 422);
      if (input.wipeId) {
        const job = service.detail(actor, input.jobId);
        need((job.scope.wipeId || (job.scope.kind === 'current_wipe' && job.scope.id)) === input.wipeId, 'SYNC_SCOPE_MISMATCH', 403);
        if (input.type) need(job.type === input.type, 'SYNC_SCOPE_MISMATCH', 403);
      }
      return service.action(actor, input.jobId, 'cancel', { expectedRevision: input.expectedRevision }, { operationId });
    }
    need(!input.action || input.action === 'request', 'SYNC_ACTION_UNSUPPORTED', 422);
    need(input.scope || input.wipeId, 'SYNC_SCOPE_REQUIRED', 422);
    if (input.scope && input.wipeId) need((input.scope.wipeId || (input.scope.kind === 'current_wipe' && input.scope.id)) === input.wipeId, 'SYNC_SCOPE_MISMATCH', 403);
    return service.request(actor, { type: input.type, scope: input.scope || { kind: 'current_wipe', id: input.wipeId },
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }) }, { operationId });
  }
  const mini = {
    member: { ...createMiniMemberViews({ identity, scheduling, memberSpace, stats }),
      participants: createMiniWipeParticipants({ identity, scheduling, memberSpace }) },
    profile: {
      me: ({ actor }) => memberSpace.me(actor), read: ({ actor }) => memberSpace.me(actor),
      save: args => local(args, async () => {
        const value = memberSpace.patchMe(args.actor, args.input, { operationId: args.operationId });
        // Re-read current facts on replay; the member-space receipt is not a
        // cache patch and may predate another successful edit.
        const current = identity.repo.get('members', args.actor.memberId);
        await patchStoreCache(store => {
          const rows = store.members ||= [], index = rows.findIndex(row => row.id === current.id);
          if (index < 0) rows.push(current); else rows[index] = current;
        });
        return value;
      })
    },
    members: {
      ...bridges.mini.members,
      accessStatus: ({ actor }) => {
        const info = memberSpace.bootstrap(actor, null);
        return { memberId: info.memberId, membershipStatus: info.membershipStatus, participation: info.participation,
          bindings: info.member ? memberSpace.me(actor).bindings : null, websiteLoginUrl: '/login' };
      },
      specialties: ({ actor }) => ({ specialties: members.options(actor).specialties }),
      changeStatus: args => memberWrite(args, () => members.status(args.actor, args.input.memberId, omit(args.input, ['memberId']), args.operationId)),
      specialty: args => memberWrite(args, () => members.edit(args.actor, args.input.memberId,
        { expectedRevision: args.input.expectedRevision, fields: { specialty: args.input.specialty } }, args.operationId)),
      changeSquad: args => memberWrite(args, () => members.move(args.actor, args.input.memberId, omit(args.input, ['memberId']), args.operationId)),
      remove: args => memberWrite(args, () => members.deleteMembers(args.actor,
        { targets: [{ id: args.input.memberId, expectedRevision: args.input.expectedRevision }], reason: args.input.reason }, args.operationId)),
      squads: ({ actor, input }) => members.squads(actor, input),
      saveSquad: args => memberWrite(args, () => members.saveSquad(args.actor, args.input.squadId || null, omit(args.input, ['squadId']), args.operationId)),
      deleteSquad: args => memberWrite(args, () => members.archiveSquad(args.actor, args.input.squadId, omit(args.input, ['squadId']), args.operationId)),
      squadMembers: ({ actor, input }) => {
        members.squad(actor, input.squadId, 'squads.read');
        return members.members(actor, input);
      }
    },
    scheduling: {
      list: ({ actor, input }) => scheduling.listWipes(actor, input),
      map: ({ actor, input }) => scheduling.getWipe(actor, input.wipeId),
      participants: ({ actor, input }) => scheduling.listSignups(actor, input.wipeId, input),
      candidates: ({ actor, input }) => {
        const page = scheduling.listSignups(actor, input.wipeId, input);
        // Use the real eligible roster, then require delegate permission on each
        // signup resource. No fabricated Steam/binding or old participant list.
        return { ...page, items: page.items.filter(row => can(actor, 'signups.delegate',
          { kind: 'signup', wipeId: input.wipeId, memberId: row.memberId }, identity.relations())),
          counts: undefined, excludedResponses: undefined, countScope: 'authorized_delegate_candidates' };
      },
      create: args => local(args, () => scheduling.createWipe(args.actor, args.input, { operationId: args.operationId, source: 'wechat' })),
      edit: args => local(args, () => scheduling.updateWipe(args.actor, args.input.wipeId, omit(args.input, ['wipeId']), { operationId: args.operationId, source: 'wechat' })),
      publish: transition('publish'), open: transition('reopen-signup'), closeSignup: transition('close-signup'), end: transition('end'),
      delegate: signup(false), withdraw: signup(true),
      ...(notifications ? { servers: ({ actor, input }) => {
        authorize(actor, 'wipes.read', { kind: 'account', id: '__collection__' }, identity.relations());
        return notifications.listWipeOptions(actor, { ...input, kind: 'servers' });
      } } : {})
    },
    stats: {
      ranking: ({ actor, input }) => stats.list(actor, { ...input, sourceId: input.sourceId || 'vital', metricVersion: 'nb-kda-1' }),
      export: async args => {
        if (args.input.kind === 'members') {
          const query = { ...omit(args.input, ['kind']), limit: Math.min(Number(args.input.limit) || 100, 100) }, page = members.members(args.actor, query);
          for (const member of page.items) authorize(args.actor, 'stats.export', { kind: 'member', id: member.id }, identity.relations());
          if (!page.items.length) authorize(args.actor, 'stats.export', { kind: 'account', id: '__collection__' }, identity.relations());
          return members.export(args.actor, query);
        }
        if (args.input.queryJobId) authorize(args.actor, 'stats.export', { kind: 'account', id: '__collection__' }, identity.relations());
        const queued = await local(args, () => stats.createJob(args.actor, 'export', args.input, args.operationId));
        // Export creation is useful without a runner; polling observes the
        // existing job. An injected shared runner remains the only executor.
        if (executeStatsJob) await executeStatsJob(queued.jobId);
        args.assertCurrent(); return stats.readJob(args.actor, queued.jobId);
      }
    },
    sync: {
      request: requestSync,
      list: ({ actor, input }) => {
        const result = sync.list(actor, input);
        // Keep the domain cursor and filter ONLY authorized projected jobs.
        // A sparse page is intentional; never replace it with unrelated jobs.
        return input.wipeId ? { ...result, items: result.items.filter(job =>
          (job.scope.wipeId || (job.scope.kind === 'current_wipe' && job.scope.id)) === input.wipeId) } : result;
      },
      profileRefresh: args => {
        need(args.actor.memberId && (!args.input.memberId || args.input.memberId === args.actor.memberId), 'MINI_SELF_PROFILE_ONLY', 403);
        return requestSync({ ...args, input: { type: 'steam_profile_backfill', scope: { kind: 'members', memberIds: [args.actor.memberId] } } });
      }
    },
    ...(system ? { admin: { logs: ({ actor, input }) => {
      try { return system.read(actor, 'logs', input); }
      catch (error) {
        if (error instanceof SystemError) throw new IdentityError(error.errorCode, error.status);
        throw error;
      }
    } } } : {})
  };
  if (executeStatsJob) mini.queries = { query: async args => {
    const { input } = args;
    const body = { sourceId: input.sourceId || 'official', steamInput: input.steamInput || input.steamId,
      ...Object.fromEntries(['serverId', 'providerWipeId', 'categoryIds', 'from', 'to'].filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
    const queued = await local(args, () => stats.createJob(args.actor, 'query', body, args.operationId));
    await executeStatsJob(queued.jobId); args.assertCurrent(); return stats.readJob(args.actor, queued.jobId);
  } };
  const platform = { ...bridges.platform,
    scheduling: { map: args => { const w = scheduling.getWipe(args.actor, args.input.wipeId); return mapResult(w,communityLanguage(args)); } },
    stats: { ranking: args => { const r = mini.stats.ranking(args); return rankingResult(r,args.input.sort||args.input.metric,communityLanguage(args)); } },
    sync: { request: args => Promise.resolve(requestSync(args)).then(result=>jobResult(result,communityLanguage(args))) },
    ...(mini.queries ? { queries: { query: args => mini.queries.query(args).then(result=>jobResult(result,communityLanguage(args))) } } : {}) };
  return { mini, platform, community: bridges.community };
}
