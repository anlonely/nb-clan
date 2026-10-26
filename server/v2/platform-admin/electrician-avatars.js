const STEAM_PROFILE = /^https:\/\/steamcommunity\.com\/(profiles\/(\d{17})|id\/[A-Za-z0-9_-]{2,64})\/$/;
const MAX_XML_BYTES = 128 * 1024;

export function steamAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      (url.hostname === 'avatars.steamstatic.com' || /^avatars\.[a-z]+\.steamstatic\.com$/.test(url.hostname)) &&
      /^\/[a-f0-9]{40}(?:_(?:full|medium))?\.(?:jpg|png)$/i.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

// Reuse the same Steam-keyed member/profile cache used by member administration.
// Only a validated public Steam CDN URL leaves this projection.
export function storedSteamAvatar(db, steamId) {
  if (!/^\d{17}$/.test(steamId)) return '';
  const members = db.prepare("SELECT payload_json FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? LIMIT 2").all(steamId).map(row => JSON.parse(row.payload_json));
  for (const member of members) {
    const avatar = [member.steamAvatar, member.avatar, member.avatarUrl].map(steamAvatarUrl).find(Boolean);
    if (avatar) return avatar;
  }
  const profiles = db.prepare("SELECT payload_json FROM json_records WHERE collection='memberProfiles' AND json_extract(payload_json,'$.steamId')=? LIMIT 2").all(steamId).map(row => JSON.parse(row.payload_json));
  return profiles.filter(profile => !profile.memberId || members.some(member => member.id === profile.memberId))
    .map(profile => steamAvatarUrl(profile.avatar)).find(Boolean) || '';
}

const xmlTag = (xml, name) => {
  const value = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${name}>`, 'i').exec(xml);
  return (value?.[1] || value?.[2] || '').trim();
};

/** Bounded, process-owned cache. Public callers cannot supply an upstream URL;
 * the only inputs are validated rows from the enabled electrician card. */
export function createElectricianAvatars({ fetchImpl, readCachedAvatar = () => '', now = Date.now,
  timeoutMs = 2500, waitMs = 3500, ttlMs = 6 * 3600000, failureTtlMs = 5 * 60000,
  concurrency = 4, maxEntries = 80 } = {}) {
  const cache = new Map(), queue = [], active = new Set(), controllers = new Set();
  let stopped = false;
  async function remote(url, signal) {
    const response = await fetchImpl(`${url}?xml=1`, { method: 'GET', signal, redirect: 'error',
      headers: { accept: 'text/xml,application/xml' } });
    let reader;
    try {
      if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > MAX_XML_BYTES) throw new Error('Steam profile unavailable');
      reader = response.body?.getReader();
      if (!reader) return '';
      const chunks = []; let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_XML_BYTES) throw new Error('Steam profile too large');
        chunks.push(value);
      }
      const xml = Buffer.concat(chunks).toString('utf8'), id = xmlTag(xml, 'steamID64');
      if (!/^\d{17}$/.test(id) || STEAM_PROFILE.exec(url)?.[2] && !url.includes(`/profiles/${id}/`)) return '';
      return steamAvatarUrl(xmlTag(xml, 'avatarFull')) || steamAvatarUrl(xmlTag(xml, 'avatarMedium'));
    } finally {
      try { if (reader) await reader.cancel(); else await response.body?.cancel(); } catch { /* Upstream may already have aborted. */ }
      reader?.releaseLock();
    }
  }
  async function refresh(url, entry) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const id = STEAM_PROFILE.exec(url)?.[2];
      const cached = id ? steamAvatarUrl(await readCachedAvatar(id)) : '';
      const avatar = cached || (fetchImpl && !stopped && !controller.signal.aborted ? await remote(url, controller.signal) : '');
      if (!stopped && !controller.signal.aborted && avatar) { entry.avatar = avatar; entry.until = now() + ttlMs; }
      else entry.until = now() + failureTtlMs;
    } catch { entry.until = now() + failureTtlMs; }
    finally { controller.abort(); clearTimeout(timer); controllers.delete(controller); }
  }
  function pump() {
    while (!stopped && active.size < concurrency && queue.length) {
      const { url, entry, resolve } = queue.shift();
      const work = refresh(url, entry).finally(() => { entry.pending = null; active.delete(work); resolve(); pump(); });
      active.add(work);
    }
  }
  function lookup(url) {
    if (!STEAM_PROFILE.test(url) || stopped) return Promise.resolve();
    let entry = cache.get(url);
    if (entry?.pending) return entry.pending;
    if (entry?.until > now()) return Promise.resolve();
    if (!entry) {
      if (cache.size >= maxEntries) {
        const oldest = [...cache].find(([, value]) => !value.pending)?.[0];
        if (!oldest) return Promise.resolve();
        cache.delete(oldest);
      }
      entry = { avatar: '', until: 0, pending: null }; cache.set(url, entry);
    }
    let resolve;
    entry.pending = new Promise(done => { resolve = done; });
    queue.push({ url, entry, resolve }); pump();
    return entry.pending;
  }
  return {
    async read(details) {
      const rows = [...details.china, ...details.foreign];
      const work = Promise.all(rows.map(row => lookup(row.url)));
      let timer;
      try { await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
      finally { clearTimeout(timer); }
      const project = row => ({ name: row.name, url: row.url, avatar: cache.get(row.url)?.avatar || '' });
      return { china: details.china.map(project), foreign: details.foreign.map(project) };
    },
    async stop() {
      stopped = true;
      for (const job of queue.splice(0)) { job.entry.pending = null; job.resolve(); }
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...active]);
      cache.clear();
    }
  };
}
