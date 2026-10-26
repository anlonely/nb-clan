const IMMUTABLE = 'public, max-age=31536000, immutable';
const tutorialVersions = new Map([
  ['guides/kook-steam-binding.mp4', 'binding-hq'],
  ['guides/kook-steam-binding-poster.jpg', 'binding-hq'],
  ['guides/add-steam-friend.mp4', 'tutorial-hq'],
  ['guides/add-steam-friend-poster.jpg', 'tutorial-hq'],
]);

export function staticCacheControl(relativePath, requestUrl = '') {
  if (relativePath.startsWith('assets/')) return IMMUTABLE;
  if (relativePath === 'guides/tutorial-media-sw.js') return 'no-store';
  if (relativePath === 'index.html' || relativePath === 'loading-cache-sw.js' ||
      /^guides\/.*\.(?:html|js|css)$/.test(relativePath)) return 'no-cache';

  const family = tutorialVersions.get(relativePath);
  if (!family) return undefined;
  const query = requestUrl.includes('?') ? requestUrl.slice(requestUrl.indexOf('?') + 1) : '';
  const match = /^v=(binding-hq|tutorial-hq)-([1-9]\d{0,5})$/.exec(query);
  // Only one exact version parameter is immutable. Every media update must bump it.
  return match?.[0] === query && match[1] === family ? IMMUTABLE : 'public, max-age=0';
}

export function setStaticCacheHeaders(res, relativePath, requestUrl = '') {
  const cacheControl = staticCacheControl(relativePath, requestUrl);
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  if (relativePath === 'guides/tutorial-media-sw.js') {
    // Keep worker updates fresh even when the CDN applies its own browser TTL.
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  }
}
