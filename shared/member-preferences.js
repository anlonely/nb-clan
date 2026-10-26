// Canonical member choices shared by self-service, administration and API writes.
export const specialties = Object.freeze({
  pvp: 'PVP', farming: '种植', breeding: '养殖', electricity: '电力', building: '建筑',
  pipe: '管道', gunman: '枪男', commander: '指挥', translator: '翻译官', logistics: '后勤',
  external_lead: '外领', miner: '矿工', merchant: '商人'
});
const aliases = Object.freeze({
  gunner: 'pvp', '狙击': 'pvp', '枪手': 'pvp', '炸家': 'pvp', '防守': 'pvp', '电工': 'electricity',
  '资源采集': 'miner', '后勤管理': 'logistics', '跑图 / 开卡': 'logistics', '跑图': 'logistics', '开卡': 'logistics',
  interpreter: 'translator', '翻译': 'translator', horse: 'breeding', '养马': 'breeding', '奸商': 'merchant',
  '外交沟通': 'external_lead',
  rich: '', '神豪': '', '土豪': '', whale: '', 'high roller': '', high_roller: '',
  laborer: '', '黑奴': '', actor: '', '演员': '', appearance: '', '颜值': '',
  male_star: '', '男明星': '', female_star: '', '女明星': '', shitposter: '', '你是来💩的吧': '',
  other: '', '其他': '', '麻瓜': '', '新手待培养': '', '飞行': '', '情报侦查': ''
});
export function normalizeSpecialties(value = [], { strict = false } = {}) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，、;；]/);
  if (strict && list.length > 30) throw new TypeError('INVALID_SPECIALTIES');
  return [...new Set(list.map(item => {
    const raw = String(item).trim();
    const key = Object.hasOwn(specialties, raw) ? raw : Object.entries(specialties).find(([, label]) => label === raw)?.[0] ?? aliases[raw];
    if (strict && raw && key === undefined) throw new TypeError('INVALID_SPECIALTIES');
    return key || '';
  }).filter(Boolean))];
}
export const specialtyQueryValues = key => [key, specialties[key], ...Object.entries(aliases).filter(([, value]) => value === key).map(([alias]) => alias)].filter(Boolean);
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function timeZoneOptions(current = '') {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  // Include UTC, and valid persisted aliases that Intl canonical lists omit.
  return [...new Set(['UTC', ...zones, current].filter(Boolean))].sort();
}
