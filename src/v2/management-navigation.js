import { t } from './i18n.js';
const entries = [
  ['wipes', '/admin/wipes', '档期与通知'], ['members', '/admin/members', '成员与组织'],
  ['stats', '/admin/stats', '战绩与查询'], ['sync', '/admin/sync', '同步中心'],
  ['realtime', '/admin/realtime/info', '战队实时'], ['bot', '/admin/bot/features', 'Bot 功能管理'],
  ['platforms', '/admin/platforms/discord', '平台接入'],
  ['system', '/admin/system/brand', '系统管理']
];
export function managementNavigation(session) {
  if (session?.workspaces?.admin !== true) return [];
  const allowed = new Set(Array.isArray(session.managementSections) ? session.managementSections.map(s => s.id) : ['wipes']);
  return entries.filter(([id]) => allowed.has(id)).map(([id, path, label]) => {
    const preferred = session.managementSections?.find(s => s.id === id)?.path;
    if (id === 'stats' && /^\/admin\/stats\/query\?source=(official|member|vital|moose|inventory)$/.test(preferred || '')) path = preferred;
    if (id === 'platforms' && preferred === '/admin/platforms/sources') path = preferred;
    if (id === 'bot' && /^\/admin\/bot\/(?:features|servers|open-signups|electricians|tools|activity)(?:\?platform=(?:discord|kook))?$/.test(preferred || '')) path = preferred;
    if (id === 'system' && /^\/admin\/system\/(brand|storage|proxy|logs|public-api|accounts|permissions)$/.test(preferred || '')) path = preferred;
    return { id, path, label: t(label) };
  });
}
export const managementHome = session => managementNavigation(session)[0]?.path || '/help';
export function managementSection(path) {
  const route = path.split(/[?#]/)[0];
  const match = /^\/admin\/(members|stats|sync|realtime|bot|platforms|system)(?:\/|$)/.exec(route);
  if (match) return match[1];
  return /^\/admin(?:\/?$|\/(?:wipes|notifications|publish-intents|deliveries)(?:\/|$))/.test(route) ? 'wipes' : null;
}
