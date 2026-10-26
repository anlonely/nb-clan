import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { discordTimestamp } from '../notification-platforms/discord-time.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

export const SERVER_CONNECT_COMMAND_ID = 'server_connect_card';
export const serverConnectTargetId = (id, platform = 'kook') => `server_connect_${createHash('sha256').update(`${platform}:${id}`).digest('hex').slice(0, 24)}`;

export async function resolveServerConnectIp(command, lookup = resolve4) {
  const match = /^(?:client\.)?connect +([a-z0-9.-]+):([0-9]{1,5})$/i.exec(command);
  if (!match || isIP(match[1])) return null;
  try { return (await lookup(match[1])).find(address => isIP(address) === 4) || null; }
  catch { return null; }
}

// An editable preview may replace these three display values only. Never accept
// console command chaining or fields that could redirect delivery to a channel.
export function normalizeServerConnectOverride(value) {
  const fields = ['name', 'serverScheduledWipeAt', 'command'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      fields.some(key => typeof value[key] !== 'string')) return null;
  const name = value.name.trim(), command = value.command.trim(), at = value.serverScheduledWipeAt;
  if (!name || name.length > 180 || /[\x00-\x1f\x7f]/.test(value.name) || command.length > 300 ||
      /[\x00-\x1f\x7f]/.test(value.command)) return null;
  const match = /^(?:client\.)?connect +([a-z0-9.-]+|\[[a-f0-9:]+\]):([0-9]{1,5})$/i.exec(command);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  const host = match[1];
  if (host.startsWith('[') ? isIP(host.slice(1, -1)) !== 6 :
      /^[0-9.]+$/.test(host) ? isIP(host) !== 4 :
        host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  const stamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(at);
  const instant = Date.parse(at);
  if (!stamp || !Number.isFinite(instant) || Number(stamp[4]) > 23 || Number(stamp[5]) > 59 || Number(stamp[6] || 0) > 59 ||
      new Date(Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]))).toISOString().slice(0, 10) !== at.slice(0, 10)) return null;
  return { name, serverScheduledWipeAt: new Date(instant).toISOString(), command };
}

export function serverConnectDetails(wipe, resolvedIp = null) {
  const snapshot = wipe.serverSnapshot || {};
  const title = String(wipe.title || '').replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  const name = String(snapshot.name || snapshot.label || '').replace(/[\r\n]/g, ' ').trim();
  const command = String(snapshot.connectCommand || snapshot.directConnect || snapshot.connect || '').trim();
  const instant = Date.parse(wipe.serverScheduledWipeAt || '');
  if (!name || !command || !Number.isFinite(instant) || /[\r\n`@]|\((?:met|rol)\)/i.test(command) || command.length > 300) return null;
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
  const match = /^(?:client\.)?connect +([a-z0-9.-]+):([0-9]{1,5})$/i.exec(command);
  const ipCommand = match && isIP(match[1]) === 0 && isIP(resolvedIp) === 4 ? `client.connect ${resolvedIp}:${match[2]}` : null;
  return { title, name: name.slice(0, 180), wipeTime: `${date}（UTC+8）`, wipeAt: new Date(instant).toISOString(), command, ipCommand };
}

export function serverConnectPayload(channelId, details) {
  return { type: 10, target_id: channelId, content: JSON.stringify([{ type: 'card', theme: 'primary', size: 'lg', modules: [
    { type: 'header', text: { type: 'plain-text', content: '⚡ 服务器直连' } },
    ...(details.title && details.title !== details.name ? [{ type: 'section', text: { type: 'plain-text', content: details.title } }] : []),
    { type: 'section', text: { type: 'plain-text', content: details.name } },
    { type: 'divider' },
    { type: 'section', text: { type: 'kmarkdown', content: `**WIPE 时间**\n${details.wipeTime}` } },
    { type: 'section', text: { type: 'kmarkdown', content: `**服务器直连 · 点击代码块复制**\n\`\`\`\n${details.command}\n\`\`\`` } },
    ...(details.ipCommand ? [{ type: 'section', text: { type: 'kmarkdown', content: `**IP 直连 · 点击代码块复制**\n\`\`\`\n${details.ipCommand}\n\`\`\`` } }] : [])
  ] }]) };
}

const discordConnectCopy = {
  en: ['⚡ Server Direct Connect', 'Wipe Time', 'To be confirmed', 'Direct Connect · copy the command', 'IP Direct Connect · copy the command'],
  'zh-CN': ['⚡ 服务器直连', '清档时间', '待确定', '服务器直连 · 复制命令', 'IP 直连 · 复制命令'],
  ru: ['⚡ Прямое подключение к серверу', 'Время вайпа', 'Будет уточнено', 'Прямое подключение · скопируйте команду', 'Подключение по IP · скопируйте команду'],
  tr: ['⚡ Sunucuya doğrudan bağlan', 'Wipe zamanı', 'Daha sonra belirlenecek', 'Doğrudan bağlantı · komutu kopyalayın', 'IP ile bağlantı · komutu kopyalayın'],
  th: ['⚡ เชื่อมต่อเซิร์ฟเวอร์โดยตรง', 'เวลาไวป์', 'รอยืนยัน', 'เชื่อมต่อโดยตรง · คัดลอกคำสั่ง', 'เชื่อมต่อด้วย IP · คัดลอกคำสั่ง'],
  ko: ['⚡ 서버 바로 연결', '와이프 시간', '추후 확정', '바로 연결 · 명령어 복사', 'IP로 연결 · 명령어 복사'],
};

export function discordServerConnectPayload(details, language = 'en') {
  const copy = discordConnectCopy[discordInteractionLanguage(language)];
  const title = (details.title || '').trim();
  const description = [title && title !== details.name ? title : '', details.name].filter(Boolean).join('\n');
  return {
    content: '',
    embeds: [{
      title: copy[0],
      description: description.replaceAll('@', '＠').replaceAll('<', '‹').replaceAll('>', '›'),
      color: 0x5865f2,
      fields: [
        { name: copy[1], value: discordTimestamp(details.wipeAt) || copy[2], inline: false },
        { name: copy[3], value: `\`\`\`\n${details.command}\n\`\`\``, inline: false },
        ...(details.ipCommand ? [{ name: copy[4], value: `\`\`\`\n${details.ipCommand}\n\`\`\``, inline: false }] : []),
      ],
    }],
    components: [],
    allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
  };
}
