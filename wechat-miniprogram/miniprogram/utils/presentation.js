function text(value, fallback = '暂无') { return value === undefined || value === null || value === '' ? fallback : String(value); }
function hours(value) { return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '暂无数据' : `${(Number(value) / 60).toFixed(1)} 小时`; }
function date(value) {
  if (!value) return '时间待定';
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return '时间待定';
  const shifted = new Date(stamp + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}
// Keep the packaged client labels aligned with shared/member-preferences.js.
// The cross-contract test verifies every canonical label; unknown values remain visible.
const specialtyLabels = {
  pvp: 'PVP', farming: '种植', breeding: '养殖', electricity: '电力', building: '建筑',
  pipe: '管道', gunman: '枪男', commander: '指挥', translator: '翻译官', logistics: '后勤',
  external_lead: '外领', miner: '矿工', merchant: '商人'
};
function specialties(values = []) { return values.map(value => specialtyLabels[value] || value).join(' · ') || '暂无专长'; }
const badgeTones = ['blue', 'violet', 'teal', 'amber', 'rose', 'cyan'];
const specialtyTones = { pvp: 'rose', farming: 'teal', breeding: 'teal', electricity: 'amber', building: 'blue',
  pipe: 'cyan', gunman: 'rose', commander: 'violet', translator: 'cyan', logistics: 'teal', external_lead: 'violet', miner: 'amber', merchant: 'amber' };
function badgeTone(value) {
  const name = String(value || '');
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return badgeTones[hash % badgeTones.length];
}
function specialtyTags(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].map(value => {
    const id = String(value), canonical = Object.keys(specialtyLabels).find(key => key === id || specialtyLabels[key] === id);
    return { id, label: specialtyLabels[id] || id, tone: specialtyTones[canonical] || badgeTone(id) };
  });
}
function roleTags(values = []) {
  return values.map(item => {
    const name = String(item.name || '');
    const tone = item.id === 'owner' || /所有者|服主|创始/.test(name) ? 'amber'
      : item.id === 'admin' || /管理/.test(name) ? 'violet'
        : /管道|\bEU\b/i.test(name) ? 'cyan' : /\bCN\b/i.test(name) ? 'blue' : badgeTone(name || item.id);
    return { ...item, tone };
  });
}
const responseLabels = { attending_on_time: '准时参加', attending_later: '晚点参加', not_attending: '不参加' };
const lifecycleLabels = { draft: '草稿', scheduled: '准备开荒', active: '进行中', ended: '已结束', archived: '已归档', cancelled: '已取消' };
function signupLabel(signup = {}) { return signup.response ? responseLabels[signup.response] || '已报名' : '未报名'; }
function member(item = {}) { return { ...item, name: item.name || item.steamNickname || '成员', specialtiesText: specialties(item.specialties), specialtyTags: specialtyTags(item.specialties), squadsText: (item.squads || []).map(s => s.name).join(' · ') || '未分队' }; }
function wipe(item = {}) {
  item = { ...item, startsAt: item.serverStartsAt || item.startsAt };
  const terminal = ['ended', 'archived', 'cancelled'].includes(item.lifecycle);
  return { ...item, startsAtText: date(item.startsAt), closesAtText: date(item.signupClosesAt), lifecycleText: lifecycleLabels[item.lifecycle] || '准备中', signupText: signupLabel(item.mySignup), canSignup: !terminal && item.signupWindow === 'open', windowText: item.signupWindow === 'open' ? '报名开放' : item.signupWindow === 'not_open' ? '报名未开始' : '报名已截止', arrivalText: item.mySignup?.expectedArrivalAt ? date(item.mySignup.expectedArrivalAt) : '' };
}
function parseLinkQr(value) {
  const source = String(value || '').trim();
  if (!/^nbclan:wechat-link:[A-Za-z0-9_-]{43}$/.test(source)) throw new Error('请扫描官网「关联微信」页面的二维码');
  return source;
}
function arrivalIso(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new Error('请选择预计到达日期和时间');
  const iso = `${day}T${time}:00+08:00`;
  if (!Number.isFinite(Date.parse(iso)) || date(iso).slice(0, 10) !== day) throw new Error('预计到达时间无效');
  return new Date(iso).toISOString();
}
module.exports = { text, hours, date, specialties, specialtyTags, roleTags, signupLabel, member, wipe, parseLinkQr, arrivalIso };
