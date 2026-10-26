// Public deployment defaults. Never infer a deployment from request headers.
export const DEFAULT_BRAND_NAME = 'Clan Portal';
export function brandName(env = process.env) {
  const value = String(env.NB_BRAND_NAME || DEFAULT_BRAND_NAME).trim();
  return value && value.length <= 64 && !/[<>\x00-\x1f\x7f`*_[\]{}&]/.test(value) ? value : DEFAULT_BRAND_NAME;
}
export function siteOrigin(env = process.env) {
  try {
    const value = new URL(env.NB_V2_PUBLIC_ORIGIN || env.NB_PUBLIC_BASE_URL || 'https://clan.example.com');
    if (value.username || value.password || value.search || value.hash || value.pathname !== '/' ||
        !(value.protocol === 'https:' || value.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(value.hostname))) throw new Error();
    return value.origin;
  } catch { return 'https://clan.example.com'; }
}
export function deploymentText(value) {
  return String(value).replaceAll('Clan Portal', brandName()).replaceAll('https://clan.example.com', siteOrigin());
}
