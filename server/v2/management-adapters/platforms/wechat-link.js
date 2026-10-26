import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PlatformAdminRepository } from '../../platform-admin/repository.js';
import { PlatformMediaRepository } from '../../platform-media/repository.js';
import { decodeAvatar } from '../../platform-media/image.js';
import { digest } from '../../platform-media/model.js';
import { verifiedMiniIdentity } from '../../platform-admin/mini-program.js';
import { hash, need } from '../../platform-admin/model.js';

const TTL = 300000;
const PROFILE_AVATAR = '/api/v2/mini-program/profile/avatar';
const fields = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), 'WECHAT_LINK_INPUT_INVALID', 422);

/** The WeChat subject is a guest credential until its owner confirms an existing
 * canonical account. No account, Steam binding or membership is created here. */
export function createWechatLinkService({ identity, appId, legacyAppId, authenticate, runStoreWriteTask, patchStoreCache, lifecycle, readConfig, now = Date.now, sessionTtlMs = 3600000 }) {
  const repo = new PlatformAdminRepository(identity.repo.db), media = new PlatformMediaRepository(identity.repo.db), provider = `wechat:${appId}`;
  const configuration = () => { const current = readConfig?.(); need(current?.enabled === true && current.appId === appId, 'MINI_PROGRAM_NOT_CONFIGURED', 503); return hash(current); };
  const stamp = () => new Date(now()).toISOString();
  const subject = envelope => { lifecycle.assertReady(); return authenticate(envelope, { allowUnbound: true }); };
  const write = fn => lifecycle.track(() => runStoreWriteTask(fn));
  const userFor = (openid, create = false) => {
    const all = identity.repo.all('wechatUsers');
    const users = all.filter(row => row.appId === appId && row.openid === openid);
    need(users.length <= 1, 'IDENTITY_CONFLICT', 409);
    if (users.length) return users[0];
    // A legacy row has no app scope of its own. Reuse only when the migration
    // pinned this exact subject/account to the still-matching legacy app config.
    // Remote legacy avatars never become trusted uploads through this path.
    const mapping = identity.identity(provider, openid), settings = identity.repo.scalar('settings');
    const legacyApp = settings?.wechat?.appId || settings?.wechatMini?.appId;
    if (mapping?.source === 'legacy_wechat' && legacyApp === appId) {
      const account = identity.repo.get('accounts', mapping.accountId);
      const legacy = all.filter(row => !row.appId && row.openid === openid);
      need(legacy.length <= 1, 'IDENTITY_CONFLICT', 409);
      if (legacy.length === 1 && account?.memberId && legacy[0].memberId === account.memberId) {
        return { ...legacy[0], appId, avatarUrl: '', avatarUploadId: undefined, avatarRevision: 0 };
      }
    }
    // The original login used a server-side AppID but did not store it on guest
    // rows. Upgrade only an unlinked guest from that same pinned application;
    // never create a duplicate OpenID or infer a canonical account from it.
    const legacy = all.filter(row => !row.appId && row.openid === openid);
    const pins = [legacyAppId, settings?.wechat?.appId, settings?.wechatMini?.appId].filter(Boolean);
    if (legacy.length === 1 && legacyAppId === appId && pins.every(pin => pin === appId) && !mapping) {
      const old = legacy[0];
      const referenced = ['users', 'members', 'accounts'].some(collection => identity.repo.all(collection).some(row => {
        const wx = row.loginProviders?.wechat;
        return [row.wechatUserId, row.wechatId, wx?.id, wx?.userId, wx?.wechatUserId].includes(old.id) ||
          [wx?.openid, wx?.openId, wx?.externalId].includes(openid);
      }));
      const claimed = identity.repo.all('identities').some(row => (row.provider === 'wechat' || row.provider.startsWith('wechat:')) &&
        (row.externalId === openid || row.externalId?.endsWith(`:${openid}`)));
      if (!old.memberId && !old.unionid && !old.accountId && (!old.status || old.status === 'guest') &&
          (!old.role || old.role === 'member') && !referenced && !claimed) {
        return { ...old, appId, memberId: null, role: 'member', status: 'guest', avatarUrl: '', avatarUploadId: undefined, avatarRevision: 0 };
      }
    }
    if (create) need(!all.some(row => row.openid === openid), 'WECHAT_PROFILE_APP_CONFLICT', 409);
    return create ? { id: `wechat_v2_${hash([appId, openid])}`, appId, openid, nickname: '', memberId: null, createdAt: stamp() } : null;
  };
  const ownerKey = user => digest([appId, user.id]);
  const profileFor = state => {
    const user = userFor(state.session.externalId), nickName = user?.nickname || '';
    const hasAvatar = Boolean(user?.avatarUploadId?.startsWith('v2_avatar_'));
    return { nickName, avatarUrl: hasAvatar ? PROFILE_AVATAR : '', complete: Boolean(nickName.trim() && hasAvatar), linked: Boolean(state.actor), kookLinked: Boolean(state.actor && identity.repo.all('identities').some(row => row.accountId === state.actor.id && row.provider === 'kook' && row.verifiedAt)), memberId: state.actor?.memberId || null };
  };
  const patch = async user => {
    if (!patchStoreCache) return;
    await patchStoreCache(store => {
      const current = identity.repo.get('wechatUsers', user.id);
      const rows = store.wechatUsers ||= [], index = rows.findIndex(row => row.id === user.id);
      if (index < 0) rows.push(current); else rows[index] = current;
      if (current.avatarUploadId) {
        const upload = media.get('uploads', current.avatarUploadId);
        if (upload) { const uploads = store.uploads ||= [], i = uploads.findIndex(row => row.id === upload.id); if (i < 0) uploads.push(upload); else uploads[i] = upload; }
      }
    });
  };
  // Persisted counters survive process restarts and are shared by all HTTP faces.
  function rate(kind, key, limit = 10) {
    const id = hash([appId, kind, key]), previous = repo.get('wechat-link-rate', id);
    const entry = previous && previous.until > now() ? previous : { count: 0, until: now() + 60000 };
    need(entry.count < limit, 'WECHAT_LINK_RATE_LIMITED', 429);
    repo.put('wechat-link-rate', id, 'wechat', '', now(), { count: entry.count + 1, until: entry.until });
    repo.db.prepare("DELETE FROM platform_admin_records WHERE kind='wechat-link-rate' AND at<?").run(now() - 600000);
  }
  function target(accountId) {
    lifecycle.assertReady(); configuration();
    const actor = identity.actorForAccount(accountId);
    const kook = identity.repo.all('identities').filter(row => row.accountId === actor.id && row.provider === 'kook' && row.verifiedAt);
    need(kook.length === 1 && actor.memberId, 'WECHAT_LINK_KOOK_REQUIRED', 403);
    const member = identity.repo.get('members', actor.memberId);
    need(member?.steamId, 'WECHAT_LINK_STEAM_REQUIRED', 403);
    return { actor, fingerprint: hash([identity.scopeDigest(actor), actor.permissionVersion, kook[0]]), public: {
      displayName: member.customName || member.displayName || member.steamNickname || '', steamId: member.steamId,
      avatar: member.avatar || '', kookId: kook[0].externalId
    } };
  }
  function available(openid, accountId) {
    const mapping = identity.identity(provider, openid);
    need(!mapping || mapping.accountId === accountId, 'WECHAT_LINK_WECHAT_CONFLICT', 409);
    const other = identity.repo.all('identities').find(row => row.provider === provider && row.accountId === accountId && row.externalId !== openid);
    need(!other, 'WECHAT_LINK_ACCOUNT_CONFLICT', 409);
    const actor = target(accountId).actor, user = userFor(openid);
    need(!user?.memberId || user.memberId === actor.memberId, 'WECHAT_LINK_WECHAT_CONFLICT', 409);
    need(!identity.repo.all('wechatUsers').some(row => row.appId === appId && row.memberId === actor.memberId && row.openid !== openid), 'WECHAT_LINK_ACCOUNT_CONFLICT', 409);
  }
  function link(id) {
    need(typeof id === 'string' && id.length <= 100, 'WECHAT_LINK_INPUT_INVALID', 422);
    const value = repo.get('wechat-link', id);
    need(value?.appId === appId, 'WECHAT_LINK_NOT_FOUND', 404);
    need(value.configHash === configuration(), 'WECHAT_LINK_CONFIG_CHANGED', 409);
    need(value.status !== 'cancelled', 'WECHAT_LINK_EXPIRED', 410);
    need(value.status === 'linked' || value.expiresAt > now(), 'WECHAT_LINK_EXPIRED', 410);
    return value;
  }
  function dto(value, browser = false) {
    const user = value.externalId && userFor(value.externalId);
    return { linkId: value.id, status: value.status, expiresAt: new Date(value.expiresAt).toISOString(),
      ...(value.accountId ? { target: target(value.accountId).public } : {}),
      ...(user ? { profile: { nickName: user.nickname || '', avatarUrl: browser && user.avatarUploadId ? `/api/v2/wechat-link/avatar?linkId=${encodeURIComponent(value.id)}` : '' } } : {}) };
  }
  function save(value) { if (!value.configHash) value = { ...value, configHash: configuration() }; repo.put('wechat-link', value.id, 'wechat', value.accountId || '', now(), value); return value; }
  function expirePrevious(where, value) {
    const rows = repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='wechat-link' AND json_extract(payload,'$.appId')=? AND json_extract(payload,?)=?").all(appId, `$.${where}`, value);
    for (const row of rows) { const previous = JSON.parse(row.payload); if (previous.status !== 'linked') save({ ...previous, status: 'cancelled' }); }
    repo.db.prepare("DELETE FROM platform_admin_records WHERE kind='wechat-link' AND at<?").run(now() - 86400000);
    need(repo.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='wechat-link'").get().n < 10000, 'WECHAT_LINK_CAPACITY', 429);
  }
  function readBlob(user) {
    need(user?.avatarUploadId, 'MEDIA_NOT_FOUND', 404);
    const blob = media.blob(ownerKey(user));
    need(blob && blob.app_id === appId && blob.user_id === user.id && blob.revision === user.avatarRevision, 'MEDIA_NOT_FOUND', 404);
    return { bytes: Buffer.from(blob.bytes), contentType: blob.content_type };
  }
  return {
    profile: envelope => profileFor(subject(envelope)),
    saveProfile: (envelope, input) => write(async () => {
      fields(input, ['nickName']);
      need(typeof input.nickName === 'string' && input.nickName.trim().length >= 1 && input.nickName.trim().length <= 32 && !/[\x00-\x1f\x7f]/.test(input.nickName), 'WECHAT_PROFILE_NICKNAME_INVALID', 422);
      const state = subject(envelope); rate('profile', state.session.externalId, 30);
      const user = { ...userFor(state.session.externalId, true), nickname: input.nickName.trim(), updatedAt: stamp() };
      if (state.actor) { need(!user.memberId || user.memberId === state.actor.memberId, 'IDENTITY_CONFLICT', 409); user.memberId = state.actor.memberId; }
      identity.repo.put('wechatUsers', user); await patch(user); subject(envelope); return profileFor(state);
    }),
    avatar: (envelope, input) => {
      fields(input, ['dataUrl']); subject(envelope); const image = decodeAvatar(input.dataUrl);
      return write(async () => {
        const state = subject(envelope); rate('avatar', state.session.externalId, 10); media.requireSchema();
        const user = userFor(state.session.externalId, true), key = ownerKey(user), uploadId = `v2_avatar_${key}`;
        if (state.actor) { need(!user.memberId || user.memberId === state.actor.memberId, 'IDENTITY_CONFLICT', 409); user.memberId = state.actor.memberId; }
        const old = media.blob(key), used = repo.db.prepare('SELECT coalesce(sum(length(bytes)),0) n FROM v2_platform_media').get().n;
        need(used - (old?.bytes.length || 0) + image.bytes.length <= 67108864, 'MEDIA_STORAGE_CAPACITY', 429);
        const revision = (user.avatarRevision || 0) + 1, url = state.actor?.memberId ? `/api/v2/platform-media/avatar-image?memberId=${encodeURIComponent(state.actor.memberId)}` : PROFILE_AVATAR;
        identity.repo.transaction(() => {
          media.writeBlob(key, appId, user.id, revision, image);
          media.put('uploads', { id: uploadId, ownerType: 'wechat_user', ownerId: user.id, kind: 'wechat_avatar', storage: 'v2_platform_media', appId,
            sha256: image.sha256, mimeType: image.contentType, size: image.bytes.length, width: image.width, height: image.height, url, revision, createdBy: user.id, createdAt: stamp() });
          identity.repo.put('wechatUsers', { ...user, avatarUrl: url, avatarRevision: revision, avatarUploadId: uploadId, updatedAt: stamp() });
        });
        await patch(user); subject(envelope); return profileFor(state);
      });
    },
    avatarImage: envelope => readBlob(userFor(subject(envelope).session.externalId)),
    createCode: (envelope, input) => write(() => {
      fields(input, []); const state = subject(envelope);
      need(!state.actor, 'WECHAT_LINK_ALREADY_LINKED', 409); need(profileFor(state).complete, 'WECHAT_PROFILE_REQUIRED', 403);
      rate('create', state.session.externalId, 5); expirePrevious('externalId', state.session.externalId);
      let code, codeHash;
      do { code = String(randomInt(100000000)).padStart(8, '0'); codeHash = hash([appId, code]); }
      while (repo.db.prepare("SELECT 1 FROM platform_admin_records WHERE kind='wechat-link' AND json_extract(payload,'$.codeHash')=?").get(codeHash));
      const value = save({ id: randomUUID(), appId, externalId: state.session.externalId, codeHash, status: 'pending', expiresAt: now() + TTL });
      return { ...dto(value), code, websitePath: '/app/wechat-link' };
    }),
    claim: (actor, input, ip = '') => write(() => {
      fields(input, ['code']); rate('claim-account', actor.id); rate('claim-ip', ip, 100);
      need(typeof input.code === 'string' && /^\d{8}$/.test(input.code), 'WECHAT_LINK_CODE_INVALID', 422);
      const row = repo.db.prepare("SELECT id FROM platform_admin_records WHERE kind='wechat-link' AND json_extract(payload,'$.codeHash')=?").get(hash([appId, input.code]));
      need(row, 'WECHAT_LINK_NOT_FOUND', 404); const value = link(row.id), destination = target(actor.id);
      need(value.status !== 'linked', 'WECHAT_LINK_CONSUMED', 409);
      need(!value.accountId || value.accountId === actor.id, 'WECHAT_LINK_CLAIMED', 409);
      available(value.externalId, actor.id);
      return dto(save({ ...value, accountId: actor.id, accountFingerprint: destination.fingerprint, status: 'awaiting_confirmation' }), true);
    }),
    createQr: (actor, input) => write(() => {
      fields(input, []); const destination = target(actor.id); rate('qr', actor.id, 5);
      need(!identity.repo.all('identities').some(row => row.provider === provider && row.accountId === actor.id && verifiedMiniIdentity(row)), 'WECHAT_LINK_ACCOUNT_CONFLICT', 409);
      expirePrevious('accountId', actor.id);
      const token = randomBytes(32).toString('base64url');
      const value = save({ id: randomUUID(), appId, accountId: actor.id, accountFingerprint: destination.fingerprint, scanHash: hash([appId, token]), status: 'pending', expiresAt: now() + TTL });
      return { ...dto(value, true), qrPayload: `nbclan:wechat-link:${token}` };
    }),
    scan: (envelope, input) => write(() => {
      fields(input, ['token']); const state = subject(envelope);
      need(!state.actor, 'WECHAT_LINK_ALREADY_LINKED', 409); need(profileFor(state).complete, 'WECHAT_PROFILE_REQUIRED', 403); rate('scan', state.session.externalId);
      need(typeof input.token === 'string' && /^nbclan:wechat-link:[A-Za-z0-9_-]{43}$/.test(input.token), 'WECHAT_LINK_QR_INVALID', 422);
      const row = repo.db.prepare("SELECT id FROM platform_admin_records WHERE kind='wechat-link' AND json_extract(payload,'$.scanHash')=?").get(hash([appId, input.token.slice(19)]));
      need(row, 'WECHAT_LINK_NOT_FOUND', 404); const value = link(row.id);
      need(value.status !== 'linked', 'WECHAT_LINK_CONSUMED', 409);
      need(!value.externalId || value.externalId === state.session.externalId, 'WECHAT_LINK_CLAIMED', 409);
      available(state.session.externalId, value.accountId);
      return dto(save({ ...value, externalId: state.session.externalId, status: 'awaiting_confirmation' }));
    }),
    miniStatus: (envelope, linkId) => {
      const state = subject(envelope), value = link(linkId);
      need(value.externalId === state.session.externalId, 'WECHAT_LINK_NOT_FOUND', 404); return dto(value);
    },
    webStatus: (actor, linkId) => { const value = link(linkId); target(actor.id); need(value.accountId === actor.id, 'WECHAT_LINK_NOT_FOUND', 404); return dto(value, true); },
    webAvatar: (actor, linkId) => { const value = link(linkId); target(actor.id); need(value.accountId === actor.id, 'WECHAT_LINK_NOT_FOUND', 404); return readBlob(userFor(value.externalId)); },
    confirm: (envelope, input) => write(async () => {
      fields(input, ['linkId']); const state = subject(envelope), value = link(input.linkId);
      need(value.externalId === state.session.externalId, 'WECHAT_LINK_NOT_FOUND', 404);
      need(value.status === 'awaiting_confirmation' && value.accountId, 'WECHAT_LINK_NOT_READY', 409);
      need(profileFor(state).complete, 'WECHAT_PROFILE_REQUIRED', 403); available(value.externalId, value.accountId);
      const destination = target(value.accountId); need(destination.fingerprint === value.accountFingerprint, 'WECHAT_LINK_ACCOUNT_CHANGED', 409);
      const token = randomBytes(32).toString('base64url'), actor = destination.actor;
      const nextSession = { appId, externalId: value.externalId, accountId: actor.id, permissionVersion: actor.permissionVersion, expiresAt: now() + sessionTtlMs };
      const user = userFor(value.externalId);
      identity.repo.transaction(() => {
        const previous = identity.identity(provider, value.externalId);
        identity.repo.put('identities', { id: previous?.id || `identity_${randomUUID()}`, provider, externalId: value.externalId, accountId: actor.id,
          verifiedAt: stamp(), proofSource: 'wechat_code_and_website_kook_confirm', revision: (previous?.revision || 0) + 1 });
        const avatarUrl = `/api/v2/platform-media/avatar-image?memberId=${encodeURIComponent(actor.memberId)}`;
        identity.repo.put('wechatUsers', { ...user, memberId: actor.memberId, avatarUrl, updatedAt: stamp() });
        const upload = user.avatarUploadId && media.get('uploads', user.avatarUploadId); if (upload) media.put('uploads', { ...upload, url: avatarUrl });
        repo.db.prepare("DELETE FROM platform_admin_records WHERE kind='mini-session' AND json_extract(payload,'$.appId')=? AND json_extract(payload,'$.externalId')=?").run(appId, value.externalId);
        repo.put('mini-session', hash(token), 'wechat', actor.id, now(), nextSession);
        const stale = repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='wechat-link' AND json_extract(payload,'$.appId')=? AND json_extract(payload,'$.externalId')=? AND id<>?").all(appId, value.externalId, value.id);
        for (const row of stale) { const pending = JSON.parse(row.payload); if (pending.status !== 'linked') save({ ...pending, status: 'cancelled' }); }
        save({ ...value, status: 'linked', linkedAt: stamp(), codeHash: undefined, scanHash: undefined });
        identity.audit('wechat.identity.self_linked', actor.id, { appId, memberId: actor.memberId, linkId: value.id });
      });
      await patch(user);
      return { token, expiresAt: new Date(nextSession.expiresAt).toISOString(), memberId: actor.memberId, profile: profileFor(subject({ token })) };
    })
  };
}
