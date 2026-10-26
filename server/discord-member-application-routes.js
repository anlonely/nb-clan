import {
  readDiscordMemberApplicationListStore,
  readDiscordMemberApplicationRuntimeStore,
  readDiscordMemberReviewCardBackfillStore
} from './discord-member-review-store.js';
import { memberDisplayName } from './steam.js';
import { normalizeText, updateStore } from './store.js';
import { legacyRegistrationReadonly, legacyRegistrationNotice } from './v2/identity/legacy.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerDiscordMemberApplicationRoutes requires ${name}`);
  }
  return value;
}

function normalizedApplicationIdSet(value) {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((item) => normalizeText(item, 120)).filter(Boolean));
}

function assertDiscordReviewStoreAvailable(store = {}) {
  if (!store.discordMemberReviewPartial) return store;
  throw Object.assign(new Error('Discord 成员审核数据暂不可用，请稍后重试'), {
    status: 503,
    code: 'discord_member_review_read_unavailable',
    cause: store.discordMemberReviewReadError || '',
    skipApiErrorLog: true
  });
}

export function registerDiscordMemberApplicationRoutes(router, {
  requireWechatOrWebReviewManager,
  defaultJsonParser,
  applicationStatuses,
  isReviewStatus,
  wechatApplicationStatus,
  reviewActorId,
  requestActorUsername,
  reconcileDiscordMemberApplicationsWithExistingMembers,
  discordSettings,
  queueDiscordMemberReviewCardSync,
  discordMemberReviewCardBackfillCandidates,
  queueDiscordMemberReviewCardPush,
  reviewDiscordMemberApplicationDirect,
  reviewDiscordMemberApplication,
  triggerNewMemberDataSyncSafe,
  queueDiscordMemberApplicationFeedback,
  publicDiscordMemberApplication,
  sortedDiscordMemberApplications
} = {}) {
  const requireReviewManager = requiredDependency('requireWechatOrWebReviewManager', requireWechatOrWebReviewManager);
  const parseJson = requiredDependency('defaultJsonParser', defaultJsonParser);
  const normalizeApplicationStatus = requiredDependency('wechatApplicationStatus', wechatApplicationStatus);
  const actorId = requiredDependency('reviewActorId', reviewActorId);
  const actorUsername = requiredDependency('requestActorUsername', requestActorUsername);
  const reconcileApplications = requiredDependency('reconcileDiscordMemberApplicationsWithExistingMembers', reconcileDiscordMemberApplicationsWithExistingMembers);
  const getDiscordSettings = requiredDependency('discordSettings', discordSettings);
  const queueReviewCardSync = requiredDependency('queueDiscordMemberReviewCardSync', queueDiscordMemberReviewCardSync);
  const reviewCardBackfillCandidates = requiredDependency('discordMemberReviewCardBackfillCandidates', discordMemberReviewCardBackfillCandidates);
  const queueReviewCardPush = requiredDependency('queueDiscordMemberReviewCardPush', queueDiscordMemberReviewCardPush);
  const directReviewApplication = requiredDependency('reviewDiscordMemberApplicationDirect', reviewDiscordMemberApplicationDirect);
  const reviewApplication = requiredDependency('reviewDiscordMemberApplication', reviewDiscordMemberApplication);
  const triggerDataSync = requiredDependency('triggerNewMemberDataSyncSafe', triggerNewMemberDataSyncSafe);
  const queueApplicationFeedback = requiredDependency('queueDiscordMemberApplicationFeedback', queueDiscordMemberApplicationFeedback);
  const toPublicApplication = requiredDependency('publicDiscordMemberApplication', publicDiscordMemberApplication);
  const sortApplications = requiredDependency('sortedDiscordMemberApplications', sortedDiscordMemberApplications);
  const validReviewStatus = requiredDependency('isReviewStatus', isReviewStatus);
  const statusKeys = Array.isArray(applicationStatuses)
    ? applicationStatuses
    : [...(applicationStatuses || [])];

  router.get('/third-party/admin/discord-member-applications', requireReviewManager, async (req, res, next) => {
    try {
      const status = normalizeText(req.query?.status, 20);
      const reconciledIds = legacyRegistrationReadonly() ? [] : await reconcileApplications(req, {
        actorUserId: actorId(req),
        actorUsername: actorUsername(req)
      });
      const store = await readDiscordMemberApplicationListStore({ status });
      assertDiscordReviewStoreAvailable(store);
      if (reconciledIds.length) {
        const reconciledIdSet = new Set(reconciledIds);
        const syncStore = await readDiscordMemberApplicationRuntimeStore({ applicationIds: reconciledIds });
        assertDiscordReviewStoreAvailable(syncStore);
        const settings = getDiscordSettings(syncStore);
        for (const application of syncStore.discordMemberApplications || []) {
          if (!reconciledIdSet.has(application.id)) continue;
          queueReviewCardSync(settings, application, req, {
            reviewedBy: application.reviewedByUserId || actorId(req)
          });
        }
      }
      const q = normalizeText(req.query?.q, 120).toLowerCase();
      const filtered = (store.discordMemberApplications || [])
        .filter((item) => !status || status === 'all' || normalizeApplicationStatus(item) === status)
        .filter((item) => {
          if (!q) return true;
          const member = item.memberId ? store.members.find((candidate) => candidate.id === item.memberId) : null;
          return [
            item.discordUserId,
            item.discordUsername,
            item.displayName,
            item.steamId,
            item.steamNickname,
            item.squadName,
            ...(item.specialties || []),
            member ? memberDisplayName(member) : ''
          ].some((value) => String(value || '').toLowerCase().includes(q));
        });
      const counts = store.summaryApplicationCounts || Object.fromEntries(statusKeys.map((item) => [item, 0]));
      if (!store.summaryApplicationCounts) {
        for (const application of store.discordMemberApplications || []) {
          const key = normalizeApplicationStatus(application);
          counts[key] = (counts[key] || 0) + 1;
        }
      }
      sendOk(res, {
        ...(legacyRegistrationReadonly() ? legacyRegistrationNotice() : {}),
        applications: sortApplications(store, filtered),
        counts
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/third-party/admin/discord-member-applications/sync-review-cards', requireReviewManager, parseJson, async (req, res, next) => {
    try {
      const ids = normalizedApplicationIdSet(req.body?.ids);
      const reconciledIds = await reconcileApplications(req, {
        ids,
        actorUserId: actorId(req),
        actorUsername: actorUsername(req)
      });
      const store = await readDiscordMemberReviewCardBackfillStore({ ids });
      assertDiscordReviewStoreAvailable(store);
      const settings = getDiscordSettings(store);
      const backfillApplications = reviewCardBackfillCandidates(store, {
        ids,
        limit: ids ? Math.max(ids.size, 1) : undefined
      });
      const backfillIds = new Set(backfillApplications.map((application) => application.id));
      const reviewedApplications = (store.discordMemberApplications || [])
        .filter((application) => !ids || ids.has(application.id))
        .filter((application) => application.status === 'approved' || application.status === 'rejected')
        .filter((application) => !backfillIds.has(application.id));
      for (const application of backfillApplications) {
        queueReviewCardPush(req, application.id);
      }
      for (const application of reviewedApplications) {
        queueReviewCardSync(settings, application, req, {
          reviewedBy: application.reviewedByUserId || actorId(req)
        });
      }
      sendOk(res, {
        queued: backfillApplications.length + reviewedApplications.length,
        backfillQueued: backfillApplications.length,
        syncQueued: reviewedApplications.length,
        reconciled: reconciledIds.length
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/third-party/admin/discord-member-applications/:id/review', requireReviewManager, parseJson, async (req, res, next) => {
    try {
      const applicationId = normalizeText(req.params.id, 120);
      const nextStatus = normalizeText(req.body?.status, 20);
      if (!validReviewStatus(nextStatus)) {
        fail(res, 400, '审核状态无效');
        return;
      }
      const adminNote = normalizeText(req.body?.adminNote || req.body?.reviewNote, 1000);
      let reviewedApplicationId = '';
      let createdMemberId = '';
      const reviewInput = {
        applicationId,
        status: nextStatus,
        adminNote,
        actorUserId: actorId(req),
        actorUsername: actorUsername(req)
      };
      const directReview = await directReviewApplication(req, reviewInput);
      if (directReview) {
        reviewedApplicationId = directReview.reviewedApplicationId;
        createdMemberId = directReview.createdMemberId;
      } else {
        await updateStore((store) => {
          const result = reviewApplication(store, req, reviewInput);
          reviewedApplicationId = result.reviewedApplicationId;
          createdMemberId = result.createdMemberId;
        });
      }
      const syncResult = createdMemberId
        ? await triggerDataSync([createdMemberId], { source: 'discord_member_application' })
        : { queued: false, requested: 0 };
      const store = await readDiscordMemberApplicationRuntimeStore({ applicationId: reviewedApplicationId });
      assertDiscordReviewStoreAvailable(store);
      const application = (store.discordMemberApplications || []).find((item) => item.id === reviewedApplicationId);
      if (application && (application.status === 'approved' || application.status === 'rejected')) {
        const settings = getDiscordSettings(store);
        queueApplicationFeedback(settings, application, req);
        queueReviewCardSync(settings, application, req, {
          reviewedBy: actorUsername(req, actorId(req))
        });
      }
      sendOk(res, {
        application: toPublicApplication(store, application),
        syncQueued: syncResult.queued ? syncResult.requested : 0
      });
    } catch (error) {
      next(error);
    }
  });
}
