import { steamLinksText as text } from './locale.js';
import { steamLinksCustomId } from './interaction-input.js';
import { steamTeamStatusKey } from './team-matching.js';

export const safeSteamLinksText = (value, max = 80) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max)
  .replace(/</g, '‹').replace(/>/g, '›').replace(/([\\`*_{}\[\]()|~])/g, '\\$1').replace(/@/g, '@\u200b');
export const privateSteamLinksPayload = (content = '', extra = {}) => ({ content, embeds: [], components: [], ...extra,
  flags: 64, allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } });
const steamUrl = steamId => `https://steamcommunity.com/profiles/${steamId}`;

export function steamTeamSummary(link, locale, { compact = false } = {}) {
  if (!link?.teamSync) return '';
  const code = ['CN', 'EU'].includes(link.teamAssignment?.code) ? link.teamAssignment.code : '—';
  const key = steamTeamStatusKey(link.teamSync.status);
  if (compact) return `${code} · ${text(locale, key.replace(/^team/, 'teamShort'))}`;
  return `${text(locale, 'teamRecorded')}: ${code}\n${text(locale, 'teamWebsite')}: ${text(locale, key)}`;
}

export function steamLinksModal(token, locale) {
  return { type: 9, data: { custom_id: steamLinksCustomId('submit', token), title: text(locale, 'modalTitle'),
    components: [{ type: 18, label: text(locale, 'identifier'), component: { type: 4, custom_id: 'identifier', style: 1,
      required: true, min_length: 1, max_length: 256, placeholder: text(locale, 'placeholder') } }] } };
}

export function steamLinkConfirmation({ token, locale, oldSteamId, steamId }) {
  return privateSteamLinksPayload('', { embeds: [{ title: text(locale, 'replaceTitle'), description: text(locale, 'declaration'), fields: [
    { name: text(locale, 'old'), value: `[${oldSteamId}](${steamUrl(oldSteamId)})` },
    { name: text(locale, 'next'), value: `[${steamId}](${steamUrl(steamId)})` },
  ] }], components: [{ type: 1, components: [
    { type: 2, style: 1, label: text(locale, 'confirm'), custom_id: steamLinksCustomId('confirm', token) },
    { type: 2, style: 2, label: text(locale, 'cancel'), custom_id: steamLinksCustomId('cancel', token) },
  ] }] });
}

export function renderSteamLinksList({ rows, mode, page, token, locale, fetchedAt }) {
  const count = rows.length, pages = Math.max(1, Math.ceil(count / 20));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const lines = rows.slice(current * 20, current * 20 + 20).map((row, index) => {
    const team = mode === 'all' ? steamTeamSummary(row, locale, { compact: true }) : '';
    const user = `[${safeSteamLinksText(row.displayName || row.discordId, team ? 14 : 30)}](https://discord.com/users/${row.discordId})`;
    return `${current * 20 + index + 1}. ${user}${mode === 'all' ? ` · [${row.steamId}](${steamUrl(row.steamId)})` : ''}${team ? ` · ${team}` : ''}`;
  });
  const controls = [
    ...(current > 0 ? [{ type: 2, style: 2, label: text(locale, 'previous'), custom_id: steamLinksCustomId('page', token, current - 1) }] : []),
    ...(current + 1 < pages ? [{ type: 2, style: 2, label: text(locale, 'nextPage'), custom_id: steamLinksCustomId('page', token, current + 1) }] : []),
  ];
  return privateSteamLinksPayload('', { embeds: [{ title: text(locale, mode === 'all' ? 'linkedTitle' : 'missingTitle'),
    description: lines.join('\n') || text(locale, mode === 'all' ? 'emptyLinked' : 'emptyMissing'),
    footer: { text: `${text(locale, 'page', { page: current + 1, pages, count })}${fetchedAt ? ` · ${text(locale, 'fetchedAt')}: ${safeSteamLinksText(fetchedAt, 40)}` : ''}` } }],
    components: controls.length ? [{ type: 1, components: controls }] : [] });
}
