import { brandName } from '../../branding.js';
import { hash, need } from '../notifications/shared.js';
import { discordExpiryTimestamp } from '../notification-platforms/discord-time.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

const providers = { vital: 'Vital', rustinity: 'Rustinity', atlas: 'Atlas' };
const copy = {
  'zh-CN': { title: 'VIP 到期提醒', priority: '优先队列', queue_skip: '免排队', body: (p, t, d) => `你的 ${p} ${t} VIP 将于 ${d} 到期。如已续费，请更新 VIP 信息。` },
  en: { title: 'VIP expiry reminder', priority: 'Priority Queue', queue_skip: 'Queue Skip', body: (p, t, d) => `Your ${p} ${t} VIP expires at ${d}. If you have renewed it, please update your VIP information.` },
  ru: { title: 'Напоминание об окончании VIP', priority: 'приоритетной очереди', queue_skip: 'пропуска очереди', body: (p, t, d) => `Ваш ${p} VIP (${t}) заканчивается ${d}. Если он продлён, обновите VIP-данные.` },
  tr: { title: 'VIP bitiş hatırlatması', priority: 'Öncelikli Sıra', queue_skip: 'Sıra Atlama', body: (p, t, d) => `${p} ${t} VIP üyeliğiniz ${d} tarihinde sona eriyor. Yenilediyseniz VIP bilgilerinizi güncelleyin.` },
  th: { title: 'แจ้งเตือนวันหมดอายุ VIP', priority: 'คิวพิเศษ', queue_skip: 'ข้ามคิว', body: (p, t, d) => `${p} VIP (${t}) ของคุณจะหมดอายุวันที่ ${d} หากต่ออายุแล้ว โปรดอัปเดตข้อมูล VIP` },
  ko: { title: 'VIP 만료 알림', priority: '우선 대기열', queue_skip: '대기열 건너뛰기', body: (p, t, d) => `${p} VIP (${t})가 ${d}에 만료됩니다. 갱신했다면 VIP 정보를 업데이트하세요.` }
};
export function preferredVipLanguage(db, externalId) {
  const row = db.prepare(`SELECT payload_json FROM json_records WHERE collection='discordMemberApplications'
    AND json_extract(payload_json,'$.discordUserId')=? AND
    (COALESCE(json_extract(payload_json,'$.discordLanguage'),'')<>'' OR COALESCE(json_extract(payload_json,'$.discordLocale'),'')<>'')
    ORDER BY position ASC,updated_at DESC,id ASC LIMIT 1`).get(externalId);
  const application = row && JSON.parse(row.payload_json);
  const locale = typeof application?.discordLocale === 'string' ? application.discordLocale.replace(/_/g, '-') : '';
  // A real client locale wins over older inferred language values. Keep the
  // saved language fallback for applications created before locale was stored.
  const raw = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale) && locale.length <= 32 ? locale
    : typeof application?.discordLanguage === 'string' ? application.discordLanguage.replace(/_/g, '-') : null;
  return discordInteractionLanguage(raw);
}
export function renderVip(member, vip, language) {
  const c = copy[language], provider = providers[vip.source];
  need(c && provider && c[vip.type], 'VIP_TEMPLATE_UNSUPPORTED', 422);
  const expiry = discordExpiryTimestamp(vip.expiresAt) || vip.expiresAt;
  const payload = { content: '', embeds: [{ title: `${provider} ${c.title}`, description: c.body(provider, c[vip.type], expiry),
    color: 0xf59e0b, footer: { text: `${brandName()} · ${provider} VIP` } }], components: [],
  allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
  return { payload, payloadHash: hash(payload), snapshot: { memberId: member.id, source: vip.source, vipType: vip.type,
    purchasedAt: vip.purchasedAt, expiresAt: vip.expiresAt, language, contentRevision: member.revision || 1, rosterRevision: null }, actionReferenceIds: [] };
}
