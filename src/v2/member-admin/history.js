const status = { active: '正常', suspended: '暂停', left: '离队', blocked: '黑名单' };
const field = { customName: '站内名称', specialty: '专长', specialties: '专长', phone: '联系电话', discordName: 'Discord 名称', discordId: 'Discord ID', wechatId: '微信号', timezone: '时区', region: '地区', notes: '内部备注', battlemetricsId: 'BattleMetrics ID', vitalVipType: 'Vital VIP', atlasVipType: 'Atlas VIP' };
const move = action => action === 'member.moveMany' || action.startsWith('member.move:');

export function visibleHistory(items) {
  const result = [];
  for (const row of items) {
    const previous = result.at(-1);
    const sameMove = previous && move(row.action) && previous.action === row.action &&
      previous.actorId === row.actorId && previous.createdAt === row.createdAt &&
      Boolean(previous.payload.fromSquadId || previous.payload.toSquadId) !== Boolean(row.payload.fromSquadId || row.payload.toSquadId);
    if (sameMove) {
      previous.payload = { ...row.payload, ...previous.payload };
      previous.fromSquadName ||= row.fromSquadName;
      previous.toSquadName ||= row.toSquadName;
      continue;
    }
    result.push({ ...row, payload: { ...row.payload } });
  }
  // Older batch moves also wrote an audit row when the squad did not change.
  // Keep that audit in storage, but do not show it as a member move.
  return result.filter(row => !move(row.action) || row.payload.fromSquadId || row.payload.toSquadId);
}

export function historyDescription(row) {
  const p = row.payload || {}, action = row.action || '';
  let title = '操作记录', detail = '';
  if (move(action) || p.fromSquadId || p.toSquadId) {
    const changed = Boolean(p.fromSquadId || p.toSquadId);
    title = changed ? '调整队伍' : '确认队伍归属';
    detail = changed ? `${row.fromSquadName || t('未分队')} → ${row.toSquadName || t('未分队')}` : t('成员归属未变更');
    if (row.memberName) detail = `${row.memberName}：${detail}`;
  } else if (action.startsWith('member.edit:')) {
    title = '编辑成员资料';
    const changed = Object.entries(field).filter(([key]) => p.before && p.after && JSON.stringify(p.before[key]) !== JSON.stringify(p.after[key]));
    const summaries = new Map();
    for (const [key, label] of changed) {
      if (summaries.has(label)) continue;
      const before = p.before[key], after = p.after[key];
      const empty = value => value === '' || value === null || value === undefined || Array.isArray(value) && !value.length;
      summaries.set(t(label), empty(after) ? t('清空') : empty(before) ? t('设置') : t('更新'));
    }
    detail = [...new Set(summaries.values())].map(verb => `${verb}: ${[...summaries].filter(([, action]) => action === verb).map(([label]) => label).join(', ')}`).join(' · ') || t('资料已更新');
  } else if (action.startsWith('member.status:')) {
    title = '调整成员状态';
    detail = `${t(status[p.previousStatus] || '原状态')} → ${t(status[p.memberStatus] || '当前状态')}`;
  } else if (action.startsWith('member.create') || p.imported) {
    title = p.imported ? '导入成员' : '新增成员';
    detail = t('成员已加入名单');
  } else if (action.startsWith('member.delete') || p.deleted) {
    title = '删除成员'; detail = t('成员档案已删除');
  } else if (action.startsWith('member.unlink')) {
    title = '解除平台关联'; detail = p.provider ? t('已解除 {provider} 关联', { provider: p.provider === 'kook' ? 'KOOK' : p.provider === 'discord' ? 'Discord' : t('微信') }) : t('平台关联已解除');
  } else if (action.startsWith('squad.save')) {
    title = p.before ? '编辑队伍' : '创建队伍'; detail = p.after?.name || t('队伍资料已更新');
  } else if (action.startsWith('squad.archive')) {
    title = '解散队伍'; detail = t('队伍已归档');
  }
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (reason && !reason.startsWith('管理员确认') && !(move(action) && reason === '入')) detail += (detail ? ' · ' : '') + reason;
  return { title: t(title), detail: detail || t('操作已记录') };
}
import { t } from '../i18n.js';
