import { requireValue } from '../identity/errors.js';

export const STEAM_LINKS_PREFIX = 'nbsteam';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const valid = condition => requireValue(condition, 'PLATFORM_PAYLOAD_INVALID', 422);
const noOptions = options => options === undefined || Array.isArray(options) && options.length === 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

export function steamLinksCustomId(action, token, page) {
  valid(['submit', 'confirm', 'cancel', 'page'].includes(action) && tokenPattern.test(token));
  valid(action !== 'page' || Number.isSafeInteger(page) && page >= 0 && page <= 5000);
  return `${STEAM_LINKS_PREFIX}:${action}:${token}${action === 'page' ? `:${page}` : ''}`;
}

export function ownsSteamLinksInteraction(event) {
  return Boolean(event?.type === 2 && ['setsteam', 'view'].includes(event.data?.name) ||
    typeof event?.data?.custom_id === 'string' && event.data.custom_id.startsWith(`${STEAM_LINKS_PREFIX}:`));
}

/** The verifier calls this only after authenticating the untouched body. */
export function parseSteamLinksInteraction(event) {
  if (!ownsSteamLinksInteraction(event)) return null;
  const data = event.data;
  if (event.type === 2) {
    valid(data.type === undefined || data.type === 1);
    if (data.name === 'setsteam') {
      valid(noOptions(data.options));
      return { kind: 'steam_links', action: 'open' };
    }
    valid(data.name === 'view' && Array.isArray(data.options) && data.options.length === 1);
    const sub = data.options[0];
    valid(sub?.type === 1 && ['user', 'all', 'nosteam'].includes(sub.name));
    if (sub.name !== 'user') {
      valid(noOptions(sub.options));
      return { kind: 'steam_links', action: `view_${sub.name}` };
    }
    valid(sub.options === undefined || Array.isArray(sub.options) && sub.options.length <= 2);
    const values = {};
    for (const option of sub.options || []) {
      valid(['user', 'identifier'].includes(option?.name) && !Object.hasOwn(values, option.name));
      valid(option.name === 'user' ? option.type === 6 && snowflake(option.value) : option.type === 3 && text(option.value));
      values[option.name] = option.value;
    }
    // Zero and two arguments are localized business errors, not auth failures.
    return { kind: 'steam_links', action: 'view_user', values };
  }
  const parts = data.custom_id.split(':');
  valid(parts[0] === STEAM_LINKS_PREFIX && tokenPattern.test(parts[2]));
  const [, action, token] = parts;
  if (action === 'page') {
    valid(parts.length === 4 && /^\d{1,4}$/.test(parts[3]) && Number(parts[3]) <= 5000 &&
      event.type === 3 && data.component_type === 2 && data.values === undefined);
    return { kind: 'steam_links', action, token, page: Number(parts[3]) };
  }
  valid(parts.length === 3);
  if (['confirm', 'cancel'].includes(action)) {
    valid(event.type === 3 && data.component_type === 2 && data.values === undefined);
    return { kind: 'steam_links', action, token };
  }
  valid(action === 'submit' && event.type === 5 && Array.isArray(data.components) && data.components.length === 1);
  const row = data.components[0];
  const field = row?.type === 18 ? row.component : row?.type === 1 && row.components?.length === 1 ? row.components[0] : null;
  valid(field?.type === 4 && field.custom_id === 'identifier' && text(field.value));
  return { kind: 'steam_links', action, token, values: { identifier: field.value.trim() } };
}

/** Whitelist the original text before any provider is invoked. No arbitrary
 * URL is ever fetched; providers use a fixed Steam API endpoint. */
export function parseSteamIdentifier(input) {
  if (typeof input !== 'string' || input.length > 256) return null;
  const value = input.trim();
  if (/^\d{17}$/.test(value)) return { kind: 'steamid', steamId: value, value };
  const match = /^https:\/\/steamcommunity\.com\/(profiles\/\d{17}|id\/[A-Za-z0-9_-]{1,64})\/?$/i.exec(value);
  if (!match) return null;
  const [kind, identifier] = match[1].split('/');
  return kind.toLowerCase() === 'profiles'
    ? { kind: 'steamid', steamId: identifier, value }
    : { kind: 'vanity', vanity: identifier, value };
}
