import { deploymentText, siteOrigin } from '../../branding.js';
import { createHash } from 'node:crypto';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';
export { DEFAULT_CHINA_ELECTRICIANS, DEFAULT_FOREIGN_ELECTRICIANS } from '../../../shared/electrician-defaults.js';

export const ELECTRICIAN_COMMAND_ID = 'electrician_ids_card';
export const ELECTRICIAN_INSTRUCTIONS = '点击 **前往添加电工Steam好友** 按钮，根据教程添加 **全部电工** Steam 好友。\n\n🟢 **加了** → 炮台可能不揍你\n🔴 **没加** → 炮台一定揍你';
export const electricianTargetId = (id, platform = 'kook') => `electrician_${createHash('sha256').update(`${platform}:${id}`).digest('hex').slice(0, 24)}`;

function parseRows(value) {
  if (typeof value !== 'string') return null;
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length > 20) return null;
  const rows = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length !== 2) return null;
    const name = parts[0].trim(), raw = parts[1].trim();
    if (!name || name.length > 40 || /[@`\r\n\[\]()<>]/.test(name)) return null;
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'steamcommunity.com' || url.username || url.password || url.port || url.search || url.hash ||
      !/^\/(?:profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?$/.test(url.pathname)) return null;
    rows.push({ name, url: `https://steamcommunity.com${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}` });
  }
  return rows;
}

export function electricianDetails(command) {
  const china = parseRows(command?.electriciansCn), foreign = parseRows(command?.electriciansForeign);
  if (!china || !foreign || !china.length && !foreign.length) return null;
  const urls = [...china, ...foreign].map(row => row.url);
  return new Set(urls).size === urls.length ? { china, foreign } : null;
}

export function electricianProfilesUrl(target, platform = 'kook') {
  if (!['kook', 'discord'].includes(platform) || ![target?.guildId, target?.electricianChannelId].every(value => /^\d{10,20}$/.test(String(value || '')))) return null;
  const params = new URLSearchParams({ ...(platform === 'discord' ? { platform } : {}), guildId: target.guildId, channelId: target.electricianChannelId });
  return `${siteOrigin()}/guides/electricians.html?${params}`;
}

export function electricianCardDetails(command, target, platform = 'kook', resolved, language) {
  const details = resolved || electricianDetails(command);
  const profilesUrl = electricianProfilesUrl(target, platform, language);
  if (!details || !profilesUrl) return null;
  return { ...details, profilesUrl, tutorialUrl: `${profilesUrl}#tutorial` };
}

export function electricianPayload(channelId, details) {
  const button = (label, value, theme = 'primary') => ({ type: 'button', theme, click: 'link', value, text: { type: 'plain-text', content: label } });
  const modules = [{ type: 'header', text: { type: 'plain-text', content: '⚡ 电工 Steam ID' } },
    { type: 'section', text: { type: 'kmarkdown', content: ELECTRICIAN_INSTRUCTIONS } },
    { type: 'action-group', elements: [button('前往添加电工Steam好友', details.profilesUrl), button('查看教程', details.tutorialUrl, 'info')] },
    { type: 'context', elements: [{ type: 'plain-text', content: `电工名单：CN电工 ${details.china.length} 位 · EU电工 ${details.foreign.length} 位` }] }];
  return { type: 10, target_id: channelId, content: JSON.stringify([{ type: 'card', theme: 'primary', size: 'lg', modules }]) };
}

const discordElectricianCopy = {
  en: { title: '⚡ Electricians’ Steam IDs', description: 'Click **Add Electricians on Steam**, follow the tutorial, and send a friend request to **every electrician on the list**.\n\n🟢 Added: turrets may spare you.\n🔴 Not added: expect to be shot.', groups: ['CN Electricians', 'EU Electricians'], count: '{count} electricians', footer: deploymentText("Clan Portal · Add all electricians before the wipe"), buttons: ['Add Electricians on Steam', 'Friend Tutorial'] },
  'zh-CN': { title: '⚡ 电工 Steam ID', description: '点击 **添加电工 Steam 好友**，按教程添加 **名单上的全部电工**。\n\n🟢 加了：炮台可能不揍你。\n🔴 没加：炮台一定揍你。', groups: ['CN 电工', 'EU 电工'], count: '{count} 位电工', footer: deploymentText("Clan Portal · 开荒前添加全部电工"), buttons: ['添加电工 Steam 好友', '好友教程'] },
  ru: { title: '⚡ Steam ID электриков', description: 'Нажмите **Добавить электриков в Steam**, следуйте инструкции и отправьте заявку в друзья **каждому электрику из списка**.\n\n🟢 Добавили: турели могут вас пощадить.\n🔴 Не добавили: турели будут стрелять.', groups: ['Электрики CN', 'Электрики EU'], count: 'Электриков: {count}', footer: deploymentText("Clan Portal · Добавьте всех электриков перед вайпом"), buttons: ['Добавить электриков в Steam', 'Как добавить в друзья'] },
  tr: { title: '⚡ Elektrikçilerin Steam ID’leri', description: '**Elektrikçileri Steam’de ekle** düğmesine basın, rehberi takip edin ve **listedeki tüm elektrikçilere** arkadaşlık isteği gönderin.\n\n🟢 Eklediniz: taretler sizi vurmayabilir.\n🔴 Eklemediniz: taretler size ateş eder.', groups: ['CN elektrikçileri', 'EU elektrikçileri'], count: '{count} elektrikçi', footer: deploymentText("Clan Portal · Wipe öncesi tüm elektrikçileri ekleyin"), buttons: ['Elektrikçileri Steam’de ekle', 'Arkadaş ekleme rehberi'] },
  th: { title: '⚡ Steam ID ของช่างไฟ', description: 'กด **เพิ่มช่างไฟเป็นเพื่อนบน Steam** ทำตามคู่มือ และส่งคำขอเป็นเพื่อนให้ **ช่างไฟทุกคนในรายชื่อ**\n\n🟢 เพิ่มแล้ว: ป้อมปืนอาจไม่ยิงคุณ\n🔴 ยังไม่เพิ่ม: ป้อมปืนจะยิงคุณ', groups: ['ช่างไฟ CN', 'ช่างไฟ EU'], count: 'ช่างไฟ {count} คน', footer: deploymentText("Clan Portal · เพิ่มช่างไฟทุกคนก่อนเริ่มไวป์"), buttons: ['เพิ่มช่างไฟเป็นเพื่อนบน Steam', 'คู่มือเพิ่มเพื่อน'] },
  ko: { title: '⚡ 전기 담당자 Steam ID', description: '**Steam 전기 담당자 친구 추가**를 누르고 안내에 따라 **명단의 모든 전기 담당자**에게 친구 요청을 보내세요.\n\n🟢 추가함: 포탑이 쏘지 않을 수 있습니다.\n🔴 추가하지 않음: 포탑이 공격합니다.', groups: ['CN 전기 담당자', 'EU 전기 담당자'], count: '전기 담당자 {count}명', footer: deploymentText("Clan Portal · 와이프 전에 모든 전기 담당자를 추가하세요"), buttons: ['Steam 전기 담당자 친구 추가', '친구 추가 안내'] },
};

export function discordElectricianPayload(details, language = 'en') {
  const copy = discordElectricianCopy[discordInteractionLanguage(language)];
  const link = (label, url) => ({ type: 2, style: 5, label, url });
  return { content: '', embeds: [{ title: copy.title,
    description: copy.description, color: 0xf1c40f,
    fields: [details.china.length, details.foreign.length].map((count, index) => ({ name: copy.groups[index], value: copy.count.replace('{count}', count), inline: true })),
    footer: { text: copy.footer },
  }], components: [{ type: 1, components: [link(copy.buttons[0], details.profilesUrl), link(copy.buttons[1], details.tutorialUrl)] }],
    allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
}
