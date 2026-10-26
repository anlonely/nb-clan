import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';
import { steamLinksText } from './locale.js';
import { privateSteamLinksPayload, safeSteamLinksText, steamTeamSummary } from './renderer.js';

const keys = ['steamProfile', 'rust', 'hours', 'visibility', 'public', 'created', 'bans', 'vac', 'gameBans', 'community', 'yes', 'no', 'bm', 'server', 'window', 'source', 'noData', 'partial', 'openSteam', 'trackedNotice'];
const translations = {
  en: ['Steam profile', 'Rust total playtime (Steam)', 'hours', 'Profile visibility', 'Public', 'Account created', 'Steam ban records', 'VAC bans', 'Game bans', 'Community ban', 'Yes', 'No', 'BM tracked server playtime', 'Server', 'Period (UTC)', 'Source', 'No data', 'Partial data', 'Open Steam profile', 'BM covers the recorded server and period; it is not lifetime Rust playtime.'],
  'zh-CN': ['Steam 资料', 'Rust 总时长（Steam）', '小时', '资料可见性', '公开', '账号创建时间', 'Steam 封禁记录', 'VAC 封禁', '游戏封禁', '社区封禁', '是', '否', 'BM 记录的服务器时长', '服务器', '统计时间段（UTC）', '来源', '暂无数据', '部分数据', '打开 Steam 主页', 'BM 仅覆盖所列服务器与时间段，不代表 Rust 总时长。'],
  ru: ['Профиль Steam', 'Общее время Rust (Steam)', 'ч.', 'Видимость профиля', 'Открыт', 'Создание аккаунта', 'Блокировки Steam', 'Блокировки VAC', 'Игровые блокировки', 'Блокировка сообщества', 'Да', 'Нет', 'Время на сервере по BM', 'Сервер', 'Период (UTC)', 'Источник', 'Нет данных', 'Частичные данные', 'Открыть профиль Steam', 'BM учитывает только указанные сервер и период, а не общее время в Rust.'],
  tr: ['Steam profili', 'Toplam Rust süresi (Steam)', 'saat', 'Profil görünürlüğü', 'Herkese açık', 'Hesap oluşturma tarihi', 'Steam yasak kayıtları', 'VAC yasakları', 'Oyun yasakları', 'Topluluk yasağı', 'Evet', 'Hayır', 'BM kayıtlı sunucu süresi', 'Sunucu', 'Dönem (UTC)', 'Kaynak', 'Veri yok', 'Kısmi veri', 'Steam profilini aç', 'BM yalnızca belirtilen sunucuyu ve dönemi kapsar; toplam Rust süresi değildir.'],
  th: ['โปรไฟล์ Steam', 'เวลาเล่น Rust ทั้งหมด (Steam)', 'ชั่วโมง', 'การเปิดเผยโปรไฟล์', 'สาธารณะ', 'วันที่สร้างบัญชี', 'ประวัติการแบน Steam', 'การแบน VAC', 'การแบนเกม', 'การแบนชุมชน', 'ใช่', 'ไม่ใช่', 'เวลาในเซิร์ฟเวอร์ที่ BM บันทึก', 'เซิร์ฟเวอร์', 'ช่วงเวลา (UTC)', 'แหล่งข้อมูล', 'ไม่มีข้อมูล', 'ข้อมูลบางส่วน', 'เปิดโปรไฟล์ Steam', 'BM ครอบคลุมเฉพาะเซิร์ฟเวอร์และช่วงเวลาที่ระบุ ไม่ใช่เวลาเล่น Rust ทั้งหมด'],
  ko: ['Steam 프로필', 'Rust 총 플레이 시간 (Steam)', '시간', '프로필 공개 상태', '공개', '계정 생성 시각', 'Steam 차단 기록', 'VAC 차단', '게임 차단', '커뮤니티 차단', '예', '아니요', 'BM에 기록된 서버 플레이 시간', '서버', '기간 (UTC)', '출처', '데이터 없음', '일부 데이터', 'Steam 프로필 열기', 'BM은 표시된 서버와 기간만 포함하며 Rust 총 플레이 시간이 아닙니다.'],
};
const copy = Object.fromEntries(Object.entries(translations).map(([locale, values]) => [locale, Object.fromEntries(keys.map((key, index) => [key, values[index]]))]));
const validSteamId = value => typeof value === 'string' && /^\d{17}$/.test(value) && BigInt(value) > 76561197960265728n && BigInt(value) <= 76561202255233023n;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('.000Z', 'Z') : '';

/** Private, source-labelled profile. Display only observed fields; the original
 * Rustistics categories and risk emoji have no source in this application. */
export function renderSteamProfile(profile, { locale, discordUserId, linked = false, steamId, link } = {}) {
  const language = discordInteractionLanguage(locale), t = key => copy[language][key], base = key => steamLinksText(language, key);
  const id = steamId || profile?.steamId;
  if (!validSteamId(id)) return privateSteamLinksPayload(base('invalid'));
  const team = linked ? steamTeamSummary(link, locale) : '';
  if (!profile || !['ok', 'private'].includes(profile.status) || profile.steamId !== id)
    return privateSteamLinksPayload([base(profile?.status === 'not_found' ? 'notFound' : 'providerFailed'), team].filter(Boolean).join('\n'));
  const enrichment = profile.enrichment || {}, steam = enrichment.steam || {}, bans = enrichment.bans || {}, bm = enrichment.battlemetrics || {};
  const status = value => value === 'private' ? base('private') : value === 'unknown' ? t('noData') :
    value === 'partial' ? t('partial') : ['error', 'failed'].includes(value) ? base('failed') : base('unavailable');
  const source = (name, fetchedAt) => `${t('source')}: ${name}${date(fetchedAt) ? ` · ${base('fetchedAt')}: ${date(fetchedAt)}` : ''}`;
  const hours = minutes => `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(minutes / 60)} ${t('hours')}`;
  const bool = value => value === true ? t('yes') : value === false ? t('no') : base('unknown');
  const fields = [{ name: base('steamId'), value: id, inline: true }];
  if (typeof discordUserId === 'string' && /^\d{17,20}$/.test(discordUserId))
    fields.push({ name: base('discord'), value: `[${discordUserId}](https://discord.com/users/${discordUserId})`, inline: true });
  if (team) fields.push({ name: base('teamWebsite'), value: team, inline: false });
  fields.push({ name: t('visibility'), value: steam.profilePublic === true ? t('public') : steam.profilePublic === false || profile.status === 'private' ? base('private') : base('unknown'), inline: true });
  fields.push({ name: t('rust'), value: `${steam.rustStatus === 'ok' && finite(steam.rustMinutes) && steam.rustMinutes > 0 ? hours(steam.rustMinutes) : status(steam.rustStatus)}\n${source('Steam', steam.fetchedAt)}`, inline: false });
  fields.push({ name: t('created'), value: date(steam.accountCreatedAt) || (profile.status === 'private' ? base('private') : t('noData')), inline: true });
  let banValue = status(bans.status);
  if (['ok', 'partial'].includes(bans.status)) banValue = [
    `${t('vac')}: ${count(bans.numberOfVacBans) ? bans.numberOfVacBans : base('unknown')}`,
    `${t('gameBans')}: ${count(bans.numberOfGameBans) ? bans.numberOfGameBans : base('unknown')}`,
    `${t('community')}: ${bool(bans.communityBanned)}`,
  ].join('\n');
  fields.push({ name: t('bans'), value: `${banValue}\n${source('Steam', bans.fetchedAt)}`, inline: false });
  const bmKnown = bm.status === 'ok' && finite(bm.trackedSeconds) && /^\d{1,30}$/.test(bm.serverId || '') && date(bm.from) && date(bm.to) && date(bm.fetchedAt);
  fields.push({ name: t('bm'), value: `${bmKnown ? `${hours(bm.trackedSeconds / 60)}\n${t('server')}: ${bm.serverId}\n${t('window')}: ${date(bm.from)} — ${date(bm.to)}\n${t('trackedNotice')}` : status(bm.status)}\n${source('BattleMetrics', bm.fetchedAt)}`, inline: false });
  const title = safeSteamLinksText(profile.displayName || t('steamProfile'), 110);
  return privateSteamLinksPayload('', { embeds: [{ title,
    description: linked ? base('declaration') : t('steamProfile'), fields,
    ...(date(profile.fetchedAt) ? { footer: { text: `${base('fetchedAt')}: ${date(profile.fetchedAt)}` } } : {}) }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: t('openSteam'), url: `https://steamcommunity.com/profiles/${id}` }] }] });
}
