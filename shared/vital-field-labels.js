import { VITAL_LOOKUP_GROUPS } from './vital-lookup-labels.js';

// Legacy lookup terms are pure data and can be shared by the screen and reports.
// Keep the source path separately so an unfamiliar statistic remains identifiable.
const labels = new Map(VITAL_LOOKUP_GROUPS.flatMap(group => group.metrics
  .filter(field => field.path).map(field => [field.path, field.label])));
const extras = {
  'combat.wounds': ['倒地次数', 'Times wounded'],
  'combat.shots': ['开枪次数', 'Shots fired'],
  'combat.deathsT3': ['T3 死亡', 'T3 deaths'],
  'combat.assists': ['助攻', 'Assists'],
  'combat.heals': ['治疗次数', 'Heals'],
  'combat.revives': ['救起队友次数', 'Revives'],
  'combat.revived': ['被救起次数', 'Times revived'],
  'pve.killsNPC.scientistnpc_roam_nvg_variant': ['夜视科学家', 'Night-vision scientists'],
  'pve.killsNPC.scientistnpc_oilrig': ['油井科学家', 'Oil rig scientists'],
  'pve.killsNPC.scientistnpc_full_shotgun': ['霰弹枪科学家', 'Shotgun scientists'],
  'pve.killsNPC.scientistnpc_patrol': ['巡逻科学家', 'Patrol scientists'],
  'pve.killsNPC.scientistnpc_excavator': ['挖掘机科学家', 'Excavator scientists'],
  'pve.killsNPC.scientistnpc_roam': ['游荡科学家', 'Roaming scientists'],
  'pve.killsNPC.scientistnpc_junkpile_pistol': ['垃圾堆科学家', 'Junkpile scientists'],
  'pve.killsNPC.scientistnpc_roamtethered': ['受限游荡科学家', 'Tethered roaming scientists'],
  'pve.killsNPC.scientistnpc_heavy': ['重装科学家', 'Heavy scientists'],
  'pve.killsNPC.scientistnpc_full_lr300': ['LR300 科学家', 'LR300 scientists'],
  'general.playTimeSeconds': ['游戏时长（秒）', 'Play time (seconds)'],
  'general.playTimeMinutes': ['游戏时长（分钟）', 'Play time (minutes)'],
  'general.playTimeHours': ['游戏时长（小时）', 'Play time (hours)']
};
for (const [path, [zh, en]] of Object.entries(extras)) labels.set(path, { zh, en });
export function vitalFieldLabel(path, language = 'zh') {
  const label = labels.get(path);
  return label?.[language] || label?.en || path || '';
}
