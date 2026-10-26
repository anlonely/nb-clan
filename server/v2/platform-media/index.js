import { authorize } from '../identity/permissions.js';
import { createMediaLifecycle } from './lifecycle.js';
import { PlatformMediaRepository } from './repository.js';
import { decodeAvatar, readImage } from './image.js';
import { digest, error, fields, identifier, integer, METRICS, need, SHARE_PAGE } from './model.js';
export { installPlatformMediaSchema } from './repository.js';
export { createPinnedMediaFetch, nodePinnedMediaRequest, createWechatCodeExchange } from './network.js';

/** One app-scoped owner; no startup I/O, implicit migration, token discovery or shared-resource shutdown. */
export function createPlatformMediaOwner({ identity, memberSpace, appId, readConfig, runStoreWriteTask, patchStoreCache,
  fetchAvatar, getAccessToken, exchangeCode, now = Date.now, ...options } = {}) {
  identifier(appId);
  need(identity?.repo?.db && memberSpace?.identity === identity, 'MEDIA_IDENTITY_MISMATCH', 503);
  const repo = new PlatformMediaRepository(identity.repo.db), lifecycle = createMediaLifecycle(options);
  const cache = new Map(), maxCacheEntries = integer(options.maxCacheEntries, 16, 1, 64),
    maxCacheBytes = integer(options.maxCacheBytes, 8388608, 2097152, 33554432), cacheTtlMs = integer(options.cacheTtlMs, 3600000, 100, 3600000);
  let cacheBytes = 0, stopping;
  const config = () => {
    const c = readConfig?.();
    need(c?.enabled === true && c.appId === appId && ((Number.isSafeInteger(c.generation) && c.generation >= 0) ||
      typeof c.generation === 'string' && c.generation.length > 0 && c.generation.length <= 128), 'MEDIA_NOT_CONFIGURED', 503);
    return c;
  };
  function authority(args, edit = false) {
    need(typeof args.assertCurrent === 'function' && typeof args.subject === 'function', 'MEDIA_TRUSTED_CONTEXT_REQUIRED', 503);
    const checked = args.assertCurrent(), actor = memberSpace.actor(args.actor);
    need(checked?.id === actor.id && checked.permissionVersion === actor.permissionVersion, 'MEDIA_CONTEXT_CHANGED', 401);
    const subject = args.subject();
    need(subject?.verified === true && subject.appId === appId && subject.accountId === actor.id && typeof subject.externalId === 'string', 'MEDIA_SUBJECT_INVALID', 403);
    const mapping = identity.identity(`wechat:${appId}`, subject.externalId);
    need(mapping?.accountId === actor.id, 'MEDIA_SUBJECT_INVALID', 403);
    const matches = identity.repo.all('wechatUsers').filter(u => u.appId === appId && u.openid === subject.externalId);
    need(matches.length === 1 && matches[0].memberId === actor.memberId, 'MEDIA_SUBJECT_INVALID', 403);
    need(actor.memberId && actor.memberStatus === 'active', 'MEMBER_VERIFICATION_REQUIRED', 403);
    memberSpace.requireMember(actor);
    if (edit) need(memberSpace.canEditProfile(actor), 'ACCESS_DENIED', 403);
    return { actor, user: matches[0], subject, fingerprint: digest([identity.scopeDigest(actor), mapping,
      [matches[0].id, matches[0].appId, matches[0].openid, matches[0].memberId]]) };
  }
  function operation(args, edit, fn) {
    return lifecycle.run(async context => {
      const initialConfig = config(), initial = authority(args, edit), configHash = digest(initialConfig);
      const check = () => {
        context.check(); need(digest(config()) === configHash, 'MEDIA_CONFIG_CHANGED', 409);
        const current = authority(args, edit); need(current.fingerprint === initial.fingerprint, 'MEDIA_CONTEXT_CHANGED', 401); return current;
      };
      const result = await fn({ ...context, check, config: initialConfig }); check(); return result;
    }, args.signal);
  }
  const ownerKey = user => digest([appId, user.id]);
  const avatarUrl = memberId => `/api/v2/platform-media/avatar-image?${new URLSearchParams({ memberId })}`;
  function avatarMeta(user, memberId) {
    const managed = user.avatarUploadId?.startsWith('v2_avatar_') && user.avatarUrl === avatarUrl(memberId);
    return { schema: 'platform-media/1', kind: 'avatar', memberId, revision: user.avatarRevision || 0,
      available: Boolean(managed), bytesPath: avatarUrl(memberId), source: managed ? 'managed' : user.avatarUrl ? 'legacy_reference' : 'absent' };
  }
  const describe = image => ({ contentType: image.contentType, bytes: image.bytes.length, width: image.width, height: image.height, sha256: image.sha256 });
  const refreshCache = (userId, uploadId) => patchStoreCache(store => {
    const user = repo.get('wechatUsers', userId), upload = repo.get('uploads', uploadId);
    for (const [collection, record] of [['wechatUsers', user], ['uploads', upload]]) {
      if (!record) continue; const rows = store[collection] ||= [], i = rows.findIndex(r => r.id === record.id);
      if (i < 0) rows.push(record); else rows[i] = record;
    }
  });
  function avatar(args) {
    fields(args.input, ['dataUrl', 'expectedRevision', 'sha256']);
    identifier(args.operationId);
    need(Number.isSafeInteger(args.input.expectedRevision) && args.input.expectedRevision >= 0, 'MEDIA_REVISION_REQUIRED');
    need(typeof runStoreWriteTask === 'function' && typeof patchStoreCache === 'function', 'MEDIA_WRITE_UNAVAILABLE', 503);
    return operation(args, true, async ({ check }) => {
      const image = decodeAvatar(args.input.dataUrl);
      need(typeof args.input.sha256 === 'string' && args.input.sha256 === image.inputSha256, 'MEDIA_DIGEST_MISMATCH');
      return runStoreWriteTask(async () => {
        check(); repo.requireSchema();
        const value = identity.repo.transaction(() => {
          const { actor, user } = check(), key = ownerKey(user), receiptId = digest([appId, actor.id, args.operationId]),
            commandHash = digest([user.id, args.input.expectedRevision, image.inputSha256]);
          const existing = repo.receipt(receiptId);
          if (existing) { need(existing.command_hash === commandHash, 'IDEMPOTENCY_CONFLICT', 409); return { ...existing.value, replayed: true }; }
          need((user.avatarRevision || 0) === args.input.expectedRevision, 'REVISION_CONFLICT', 409);
          need(repo.db.prepare('SELECT count(*) n FROM v2_platform_media_receipts').get().n < 10000, 'MEDIA_RECEIPT_CAPACITY', 429);
          const old = repo.blob(key), used = repo.db.prepare('SELECT coalesce(sum(length(bytes)),0) n FROM v2_platform_media').get().n;
          need(used - (old?.bytes.length || 0) + image.bytes.length <= 67108864, 'MEDIA_STORAGE_CAPACITY', 429);
          const revision = args.input.expectedRevision + 1, uploadId = `v2_avatar_${key}`, at = new Date(now()).toISOString();
          repo.writeBlob(key, appId, user.id, revision, image);
          repo.put('uploads', { id: uploadId, ownerType: 'wechat_user', ownerId: user.id, kind: 'wechat_avatar',
            storage: 'v2_platform_media', appId, sha256: image.sha256, mimeType: image.contentType, size: image.bytes.length,
            width: image.width, height: image.height, url: avatarUrl(actor.memberId), revision, createdBy: user.id, createdAt: at });
          repo.put('wechatUsers', { ...user, avatarUrl: avatarUrl(actor.memberId), avatarRevision: revision, avatarUploadId: uploadId, updatedAt: at });
          identity.audit('member.avatar.self_edit', actor.id, { memberId: actor.memberId, appId, operationId: args.operationId, revision, sha256: image.sha256 });
          const result = { operationReceipt: { operationId: args.operationId, revision, committedAt: at, result: 'committed' }, userId: user.id, uploadId };
          repo.writeReceipt(receiptId, actor.id, appId, commandHash, result); return { ...result, replayed: false };
        });
        // Commit may have succeeded before stop/cache failure. Always drain cache repair; replay re-reads latest canonical facts.
        try { await refreshCache(value.userId, value.uploadId); } catch { throw error('MEDIA_CACHE_SYNC_FAILED'); }
        const { user, actor } = check();
        return { operationReceipt: value.operationReceipt, replayed: value.replayed, current: avatarMeta(user, actor.memberId) };
      });
    });
  }
  function resolveAvatar(args, check) {
    const { actor, user } = check(), memberId = args.input.memberId || actor.memberId;
    identifier(memberId);
    authorize(actor, 'members.read', { kind: 'member', id: memberId }, memberSpace.relations([actor.memberId, memberId]));
    const member = identity.repo.get('members', memberId); need(member, 'MEDIA_NOT_FOUND', 404);
    let targetUser = memberId === actor.memberId ? user : null;
    if (!targetUser) {
      const users = identity.repo.all('wechatUsers').filter(u => u.appId === appId && u.memberId === memberId);
      if (users.length === 1) {
        const mapping = identity.identity(`wechat:${appId}`, users[0].openid), account = mapping && identity.repo.get('accounts', mapping.accountId);
        if (account?.memberId === memberId) targetUser = users[0];
      }
    }
    const local = targetUser?.avatarUploadId && repo.get('uploads', targetUser.avatarUploadId);
    if (local?.storage === 'v2_platform_media') {
      need(local.appId === appId && local.ownerType === 'wechat_user' && local.ownerId === targetUser.id &&
        local.url === targetUser.avatarUrl && local.revision === targetUser.avatarRevision, 'MEDIA_REFERENCE_INVALID', 409);
      return { memberId, user: targetUser, local, fingerprint: digest([memberId, local, targetUser.avatarRevision]) };
    }
    // Never accept a body/query URL. Only a current visible member's canonical Steam avatar can be fetched.
    const url = member.avatar || '';
    need(typeof url === 'string' && url.length <= 500, 'MEDIA_NOT_FOUND', 404);
    let parsed; try { parsed = new URL(url); } catch { throw error('MEDIA_NOT_FOUND', 404); }
    need(parsed.protocol === 'https:' && ['avatars.steamstatic.com', 'avatars.akamai.steamstatic.com'].includes(parsed.hostname) &&
      !parsed.username && !parsed.password && !parsed.hash && (!parsed.port || parsed.port === '443') && /\.(png|jpe?g|webp)$/i.test(parsed.pathname), 'MEDIA_URL_FORBIDDEN', 403);
    return { memberId, url: parsed.href, fingerprint: digest([memberId, parsed.href, member.revision]) };
  }
  function avatarImage(args, bytes = true) {
    fields(args.input, ['memberId']);
    return operation(args, false, async ({ check, signal }) => {
      const target = resolveAvatar(args, check);
      const targetCheck = () => { check(); need(resolveAvatar(args, check).fingerprint === target.fingerprint, 'MEDIA_AVATAR_CHANGED', 409); };
      if (!target.local) need(typeof fetchAvatar === 'function', 'MEDIA_FETCH_UNAVAILABLE', 503);
      if (!bytes) return { schema: 'platform-media/1', kind: 'avatar_image', memberId: target.memberId, bytesPath: avatarUrl(target.memberId) };
      let image;
      if (target.local) {
        const row = repo.blob(ownerKey(target.user));
        need(row && row.app_id === appId && row.user_id === target.user.id && row.revision === target.local.revision && row.sha256 === target.local.sha256, 'MEDIA_REFERENCE_INVALID', 409);
        image = { bytes: Buffer.from(row.bytes), contentType: row.content_type, sha256: row.sha256, width: row.width, height: row.height };
      } else {
        need(typeof fetchAvatar === 'function', 'MEDIA_FETCH_UNAVAILABLE', 503);
        const response = await fetchAvatar(target.url, { signal, allowedHosts: ['avatars.steamstatic.com', 'avatars.akamai.steamstatic.com'], maxRedirects: 2 });
        try { targetCheck(); } catch (e) { await response?.dispose?.(); throw e; }
        image = await readImage(response, signal); targetCheck();
      }
      targetCheck(); return { ...image, ...describe(image), bytes: image.bytes };
    });
  }
  function shareCode(args, bytes = true) {
    fields(args.input, ['metric']); const metric = args.input.metric ?? 'kda'; need(METRICS.includes(metric), 'MEDIA_METRIC_INVALID');
    return operation(args, false, async ({ check, signal, config: c }) => {
      need(typeof getAccessToken === 'function' && typeof exchangeCode === 'function', 'MEDIA_SHARE_UNAVAILABLE', 503);
      const { actor } = check(); authorize(actor, 'stats.read', { kind: 'member', id: actor.memberId }, identity.relations());
      if (!bytes) return { schema: 'platform-media/1', kind: 'share_code', metric, page: SHARE_PAGE,
        bytesPath: `/api/v2/platform-media/share-code?${new URLSearchParams({ metric })}` };
      const key = digest([appId, c.generation, digest(c), metric]), cached = cache.get(key);
      if (cached && cached.expiresAt > now()) { check(); return { ...cached.image, bytes: Buffer.from(cached.image.bytes), cached: true }; }
      const token = await getAccessToken({ appId, generation: c.generation, signal, assertCurrent: check }); check();
      need(token?.appId === appId && token.generation === c.generation && typeof token.accessToken === 'string' && token.accessToken.length > 0 && token.accessToken.length <= 4096, 'MEDIA_TOKEN_INVALID', 503);
      const response = await exchangeCode({ appId, generation: c.generation, accessToken: token.accessToken,
        page: SHARE_PAGE, scene: `m=${metric}`, width: 360, signal, assertCurrent: check });
      try { check(); } catch (e) { await response?.dispose?.(); throw e; }
      const image = await readImage(response, signal); check();
      if (cache.has(key)) { cacheBytes -= cache.get(key).image.bytes.length; cache.delete(key); }
      while (cache.size >= maxCacheEntries || cacheBytes + image.bytes.length > maxCacheBytes) {
        const first = cache.keys().next().value; if (first === undefined) break;
        cacheBytes -= cache.get(first).image.bytes.length; cache.delete(first);
      }
      cache.set(key, { image: { ...image, bytes: Buffer.from(image.bytes) }, expiresAt: now() + cacheTtlMs }); cacheBytes += image.bytes.length;
      return { ...image, cached: false };
    });
  }
  function stop() {
    if (!stopping) stopping = lifecycle.stop().then(() => { cache.clear(); cacheBytes = 0; });
    return stopping;
  }
  return { avatar, avatarImage, shareCode, avatarState: args => {
    fields(args.input, []); return operation(args, false, async ({ check }) => { const { actor, user } = check(); return avatarMeta(user, actor.memberId); });
  }, stop, diagnostics: () => ({ ...lifecycle.diagnostics(), appId, cacheEntries: cache.size, cacheBytes }) };
}

export function createPlatformMediaDomainAdapters(owner) {
  return { profile: { avatar: args => owner.avatar(args), avatarImage: args => owner.avatarImage(args, false),
    shareCode: args => owner.shareCode(args, false) } };
}
