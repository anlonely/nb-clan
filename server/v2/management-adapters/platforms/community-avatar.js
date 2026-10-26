import { IdentityError } from '../../identity/errors.js';
import { readImage } from '../../platform-media/image.js';
import { createMediaLifecycle } from '../../platform-media/lifecycle.js';
import { digest, need } from '../../platform-media/model.js';

const allowedHosts = ['img.kookapp.cn', 'img.kaiheila.cn'];

/** Serves only the current member's verified KOOK guild icon. No caller URL,
 * headers, credentials or redirect destination can enter the outbound request. */
export function createCommunityAvatar({ identity, memberSpace, authenticate, fetchImage, now = Date.now,
  timeoutMs = 5000, cacheTtlMs = 60000, maxCacheEntries = 16, maxCacheBytes = 8388608 } = {}) {
  const lifecycle = createMediaLifecycle({ timeoutMs, maxActive: 4 });
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0;
  function target(envelope, provider) {
    need(provider === 'kook', 'COMMUNITY_AVATAR_PROVIDER_UNSUPPORTED', 404);
    const { actor } = authenticate(envelope);
    const member = memberSpace.requireMember(actor);
    need(member && actor.memberId === member.id && actor.memberStatus === 'active', 'MEMBER_VERIFICATION_REQUIRED', 403);
    const binding = identity.repo.all('bindings').find(row => row.accountId === actor.id && row.memberId === member.id && row.status === 'verified');
    need(binding && binding.steamId === member.steamId && !member.deletedAt, 'MEMBER_VERIFICATION_REQUIRED', 403);
    const mapping = identity.repo.all('identities').find(row => row.accountId === actor.id && row.provider === provider);
    need(mapping && typeof mapping.verifiedAt === 'string' && Number.isFinite(Date.parse(mapping.verifiedAt)), 'IDENTITY_BINDING_REQUIRED', 403);
    const policy = identity.repo.all('policies').find(row => row.provider === provider && row.enabled);
    need(policy?.guildId, 'COMMUNITY_AVATAR_NOT_FOUND', 404);
    const proof = identity.repo.all('eligibility').filter(row => row.provider === provider && row.externalId === mapping.externalId &&
      row.guildId === policy.guildId && row.policyRevision === policy.policyRevision)
      .sort((a, b) => (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0))[0];
    need(proof?.status === 'eligible' && proof.community?.available !== false, 'COMMUNITY_AVATAR_NOT_FOUND', 404);
    let url;
    try { url = new URL(proof.community.iconUrl); } catch { need(false, 'COMMUNITY_AVATAR_NOT_FOUND', 404); }
    need(url.protocol === 'https:' && allowedHosts.includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash &&
      url.href.length <= 2048, 'MEDIA_URL_FORBIDDEN', 403);
    return { url: url.href, fingerprint: digest([identity.scopeDigest(actor), member.id, binding, mapping, policy.id, policy.guildId, policy.policyRevision, url.href]) };
  }
  function remember(key, image) {
    if (cache.has(key)) { cacheBytes -= cache.get(key).image.bytes.length; cache.delete(key); }
    while (cache.size >= maxCacheEntries || cacheBytes + image.bytes.length > maxCacheBytes) {
      const first = cache.keys().next().value; if (first === undefined) break;
      cacheBytes -= cache.get(first).image.bytes.length; cache.delete(first);
    }
    cache.set(key, { image, expiresAt: now() + cacheTtlMs }); cacheBytes += image.bytes.length;
  }
  function download(url) {
    const hit = cache.get(url);
    if (hit?.expiresAt > now()) return Promise.resolve(hit.image);
    if (pending.has(url)) return pending.get(url);
    const job = lifecycle.run(async ({ signal, check }) => {
      need(typeof fetchImage === 'function', 'MEDIA_FETCH_UNAVAILABLE', 503);
      let response, abort;
      const cancelled = new Promise((_, reject) => { abort = () => { Promise.resolve(response?.dispose?.()).catch(() => {}); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); });
      const work = (async () => {
        response = await fetchImage(url, { method: 'GET', redirect: 'error', allowedHosts, maxRedirects: 0,
          headers: { Accept: 'image/png,image/jpeg,image/webp' }, signal });
        try { check(); } catch (error) { await response?.dispose?.(); throw error; }
        const image = await readImage(response, signal, { maxBytes: 1048576, maxDimension: 2048 });
        check(); remember(url, image); return image;
      })();
      try { return await Promise.race([work, cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
    }).finally(() => pending.delete(url));
    pending.set(url, job); return job;
  }
  async function image(envelope, provider, signal) {
    need(!lifecycle.diagnostics().stopped, 'MEDIA_STOPPED', 503);
    const initial = target(envelope, provider);
    if (signal?.aborted) throw new IdentityError('MEDIA_CANCELLED', 503);
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(new IdentityError('MEDIA_CANCELLED', 503)); signal?.addEventListener('abort', abort, { once: true }); });
    try {
      const result = await Promise.race([download(initial.url), cancelled]);
      need(target(envelope, provider).fingerprint === initial.fingerprint, 'MEDIA_CONTEXT_CHANGED', 401);
      return { contentType: result.contentType, bytes: Buffer.from(result.bytes) };
    } finally { signal?.removeEventListener('abort', abort); }
  }
  return { image, stop: async () => { await lifecycle.stop(); cache.clear(); cacheBytes = 0; },
    diagnostics: () => ({ ...lifecycle.diagnostics(), cacheEntries: cache.size, cacheBytes, pending: pending.size }) };
}
