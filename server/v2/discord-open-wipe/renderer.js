import { brandName, siteOrigin } from '../../branding.js';
import { isIP } from 'node:net';
import { discordTimestamp } from '../notification-platforms/discord-time.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';
import { openWipeCustomId } from './interaction-input.js';
import { text } from './interaction-ui.js';

export const openWipeResponses = Object.freeze({ signup_on_time: 'on_time', signup_absent: 'absent', signup_late: 'late',
  signup_8h: 'late_8h', signup_16h: 'late_16h' });
const groups = [
  { responses: ['on_time'], key: 'signupOnTime', emoji: '✅' },
  { responses: ['absent'], key: 'signupAbsent', emoji: '❌' },
  { responses: ['late', 'late_8h', 'late_16h', 'delayed_8h', 'delayed_16h'], key: 'signupLate', emoji: '🕒' },
];
const mentions = () => ({ parse: [], roles: [], users: [], replied_user: false });
const escaped = (value, length = 80) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length)
  .replace(/([\\`*_{}\[\]()#+.!|>~])/g, '\\$1').replaceAll('@', '＠').replaceAll('<', '‹');

export function openWipeIpCommand(settings) {
  const match = /^client\.connect ([a-z0-9.-]+):([0-9]{1,5})$/i.exec(settings.directConnect || '');
  return match && !isIP(match[1]) && isIP(settings.resolvedIp) === 4 ? `client.connect ${settings.resolvedIp}:${match[2]}` : null;
}

function dateText(settings, language) {
  if (!settings.wipeAt) return '—';
  if (settings.adaptiveDisplay !== false) return discordTimestamp(settings.wipeAt);
  return `${new Intl.DateTimeFormat(language, { timeZone: settings.timeZone || 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(settings.wipeAt))} (${settings.timeZone || 'UTC'})`;
}

export function renderOpenWipeCard({ settings, signups = [], token, locale = 'en', privateView = false, publisherLocale = 'en' }) {
  const language = discordInteractionLanguage(settings.adaptiveDisplay === false ? publisherLocale : privateView ? locale : 'en');
  const t = key => text(language, key);
  const fields = [{ name: t('wipeTime'), value: dateText(settings, language), inline: false }];
  if (settings.directConnect) fields.push({ name: t('connect'), value: `\`${settings.directConnect}\``, inline: false });
  const ipCommand = openWipeIpCommand(settings);
  if (ipCommand) fields.push({ name: t('alternativeConnect'), value: `\`${ipCommand}\``, inline: false });
  for (const { responses, key } of groups) {
    const rows = signups.filter(row => responses.includes(row.response));
    const shown = [];
    for (const row of rows.slice(0, 8)) {
      const line = `[${escaped(row.name || row.discordId, 40)}](https://discord.com/users/${row.discordId})`;
      // Reserve enough of Discord's total 6000-character embed allowance for
      // notes, connection commands, and all three attendance groups.
      if (shown.join('\n').length + line.length + 30 > 700) break;
      shown.push(line);
    }
    fields.push({ name: `${t(key)} · ${rows.length}`, value: shown.length ? `${shown.join('\n')}${rows.length > shown.length ? `\n+${rows.length - shown.length}` : ''}` : t('none'), inline: true });
  }
  const button = (action, key, style = 2) => ({ type: 2, style, label: t(key), custom_id: openWipeCustomId(action, token) });
  return { content: '', embeds: [{ title: String(settings.serverName || t('createTitle')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200),
    description: [`[**${brandName()}**](${siteOrigin()}/app/home)`, settings.notes || ''].filter(Boolean).join('\n\n'),
    color: 0x5865f2, fields }], allowed_mentions: mentions(), components: [
    { type: 1, components: [button('signup_on_time', 'signupOnTime', 3), button('signup_absent', 'signupAbsent', 4),
      button('signup_late', 'signupLate'), button('settings', 'settings')] },
  ] };
}

export function openWipeCopyPayload(settings, locale) {
  const content = settings.directConnect ? text(locale, 'connectReply', { command: settings.directConnect }) : text(locale, 'noConnect');
  const ipCommand = openWipeIpCommand(settings);
  return { content: `${content}${ipCommand ? `\n${text(locale, 'alternativeConnect')}: \`${ipCommand}\`` : ''}`, allowed_mentions: mentions(), components: [] };
}

export function openWipeSignupReply(settings, response, locale) {
  const group = groups.find(row => row.responses.includes(response));
  if (!group) throw new TypeError('Unknown open wipe response');
  return { content: text(locale, 'responseSaved', { emoji: group.emoji, status: text(locale, group.key),
    server: escaped(String(settings.serverName || text(locale, 'createTitle')).replace(/\s+/g, ' '), 200) }),
    embeds: [], components: [], allowed_mentions: mentions() };
}
