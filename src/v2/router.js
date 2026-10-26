import { safeAuthReturnTo } from './auth-flow.js';

const MEMBER_ORIGIN = 'https://member.invalid';
const invalidLocation = () => ({ pathname: '', searchParams: new URLSearchParams(), hash: '' });

// Accept only root-relative local locations. Invalid input yields an unmatched
// route, so a malformed deep link cannot crash rendering or navigate elsewhere.
// Query values and hashes stay separate; only a single wipe ID is decoded once.
export function parseMemberLocation(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      /[\\\x00-\x20\x7f]/.test(path)) return invalidLocation();
  try {
    const rawPath = path.split(/[?#]/, 1)[0];
    const segments = rawPath.split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      // Reject lone UTF-16 surrogates before downstream API URL encoding.
      encodeURIComponent(decoded);
      return decoded;
    });
    // Check before URL normalization, which otherwise silently resolves dot
    // segments. Encoded separators and another decoding layer are not IDs.
    if (segments.some(segment => segment === '.' || segment === '..' ||
        /[\\/?#%\x00-\x20\x7f]/.test(segment))) return invalidLocation();
    const url = new URL(path, MEMBER_ORIGIN);
    if (url.origin !== MEMBER_ORIGIN) return invalidLocation();
    const result = { pathname: url.pathname, searchParams: url.searchParams, hash: url.hash };
    if (/^\/app\/wipes\/[^/]+$/.test(url.pathname)) result.wipeId = segments[3];
    return result;
  } catch {
    return invalidLocation();
  }
}

export function workspaceForLocation(path) {
  const { pathname } = parseMemberLocation(path);
  return /^\/admin(?:\/|$)/.test(pathname) ? 'admin' : /^\/app(?:\/|$)/.test(pathname) ? 'member' : null;
}

export function needsWorkspaceSession(path) {
  const { pathname } = parseMemberLocation(path);
  return Boolean(workspaceForLocation(path)) || pathname === '/login' || pathname === '/help';
}

export function workspaceAuthReturnTo(path) {
  const parsed = parseMemberLocation(path), workspace = workspaceForLocation(path);
  if (!workspace) return safeAuthReturnTo(parsed.searchParams.get('returnTo'));
  const pathname = ['/admin', '/admin/'].includes(parsed.pathname) ? '/admin/wipes'
    : ['/app', '/app/'].includes(parsed.pathname) ? '/app/home' : parsed.pathname;
  return safeAuthReturnTo(`${pathname}${parsed.searchParams.size ? `?${parsed.searchParams}` : ''}${parsed.hash}`);
}

export function canOpenWorkspace(session, path) {
  const workspace = workspaceForLocation(path);
  return workspace !== null && session?.workspaces?.[workspace] === true;
}
