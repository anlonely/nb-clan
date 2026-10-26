const actionLabels = {
  'wipe.create': '创建草稿', 'wipe.edit': '修改安排', 'wipe.publish': '发布安排', 'wipe.start': '开始本场',
  'wipe.end': '结束本场', 'wipe.cancel': '取消安排', 'wipe.archive': '归档本场', 'wipe.revise-archive': '修订归档',
  'wipe.close-signup': '关闭报名', 'wipe.reopen-signup': '开放或延长报名',
  'wipe.confirm-start': '确认实际开荒', 'wipe.confirm-server-start': '确认服务器已开服',
  'signup.self': '更新报名', 'signup.delegate': '代填报名', 'signup.role_removed': '离队后自动清除报名',
};
const fieldLabels = {
  title: '标题', description: '说明', serverProfileId: '服务器模板', serverSnapshot: '本场服务器资料',
  serverScheduleSource: '服务器时间来源', audience: '报名受众', timeZone: '时区', autoStart: '按计划开始',
  autoOpenSignup: '发布后开放报名', serverScheduledWipeAt: '预计开服时间', musterAt: '集合时间',
  signupOpensAt: '报名开始时间', signupClosesAt: '报名截止时间', lifecycle: '档期状态', outcome: '结束结果',
  signupWindow: '报名窗口', startMode: '开始方式', archiveRevision: '归档版本', actualStartedAt: '实际开荒时间',
  serverActualWipeAt: '实际开服时间', phaseEnteredAt: '开始阶段时间', endedAt: '结束时间', cancelledAt: '取消时间',
  startEvidence: '实际开荒确认依据', serverStartEvidence: '实际开服确认依据', settlementStatus: '归档资料状态',
  endReason: '结束原因', response: '报名回复', expectedArrivalAt: '预计到场时间', signupRevision: '报名版本',
  confirmedContentRevision: '已确认内容版本', contentRevision: '内容版本',
};
const sources = { web: '网站', discord: 'Discord', kook: 'KOOK', wechat: '微信', scheduler: '计划任务', other: '其他来源' };
const lifecycle = { draft: '草稿', scheduled: '即将开始', active: '进行中', ended: '已结束', archived: '已归档', cancelled: '已取消' };
const outcomes = { completed: '正常完成', aborted: '异常中止', cancelled: '取消' };
const windows = { open: '报名开放', not_open: '尚未开放', closed: '报名关闭' };
const starts = { manual: '手动开始', scheduled: '按计划开始' };
const responses = { attending_on_time: '准时到', attending_later: '晚些到', not_attending: '这次不来' };
const scalarLabel = (value, labels) => value === null || value === undefined ? '未记录' : Object.hasOwn(labels, value) ? labels[value] : '未识别';
const revision = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未记录';
export const safeHistoryText = (value, limit = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,limit) : '';

export function historyPerson(person, { subject = false } = {}) {
  const label = person?.labelSource === 'current' ? safeHistoryText(person.label, 160).trim() : '';
  if (label) return { text: `${!subject && person?.isSelf ? '本人 · ' : ''}${label}`, current: true };
  return { text: subject ? '成员' : person?.isSelf ? '本人' : '其他操作人', current: false };
}

export function historyActionLabel(action, state, type) {
  if (action === 'wipe.create') {
    if (state?.lifecycle === 'draft') return '创建草稿';
    return state?.signupWindow === 'open' ? '创建并开放报名' : '创建安排';
  }
  return Object.hasOwn(actionLabels, action) ? actionLabels[action]
    : type === 'signup.changed' ? '报名变更' : '安排变更';
}

// This projection cannot render event IDs, hidden identities, arbitrary object
// keys or private before/after payloads, even if a malformed DTO contains them.
export function historyEventView(event) {
  return { action: historyActionLabel(event.action, event.state, event.type),
    kind: event.type === 'signup.changed' ? 'signup' : 'wipe',
    selfSignup: event.action === 'signup.self',
    source: Object.hasOwn(sources, event.source) ? sources[event.source] : '其他来源', occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : null,
    wipeRevision: revision(event.wipeRevision), contentRevision: revision(event.contentRevision),
    actor: historyPerson(event.actor), subject: event.subject === null || event.subject === undefined ? null : historyPerson(event.subject, { subject: true }),
    reason: safeHistoryText(event.reason).trim() || null,
    changedFields: [...new Set((Array.isArray(event.changedFields) ? event.changedFields : []).filter(field => Object.hasOwn(fieldLabels, field)).map(field => fieldLabels[field]))],
    state: event.state ? [ ['档期状态', scalarLabel(event.state.lifecycle, lifecycle)], ['结束结果', scalarLabel(event.state.outcome, outcomes)],
      ['报名窗口', scalarLabel(event.state.signupWindow, windows)], ['开始方式', scalarLabel(event.state.startMode, starts)],
      ['归档版本', revision(event.state.archiveRevision)] ] : null,
    signup: event.signup ? { response: scalarLabel(event.signup.response, responses), signupRevision: revision(event.signup.signupRevision),
      confirmedContentRevision: revision(event.signup.confirmedContentRevision),
      expectedArrivalAt: typeof event.signup.expectedArrivalAt === 'string' ? event.signup.expectedArrivalAt : null,
      timeZone: typeof event.signup.timeZone === 'string' ? safeHistoryText(event.signup.timeZone, 80) : null } : null };
}

export const initialHistoryPage = () => ({ cursor: '', previous: [], resetNotice: false });
export function historyPagination(state, action) {
  if (action.type === 'next' && typeof action.cursor === 'string' && action.cursor && action.cursor !== state.cursor)
    return { cursor: action.cursor, previous: [...state.previous, state.cursor], resetNotice: false };
  if (action.type === 'previous' && state.previous.length)
    return { cursor: state.previous.at(-1), previous: state.previous.slice(0,-1), resetNotice: false };
  if (action.type === 'expired') return { ...initialHistoryPage(), resetNotice: true };
  return state;
}

export function historyFailure(error) {
  if (error?.status === 403 || error?.errorCode === 'ACCESS_DENIED') return { title: '没有查看本场操作历史的权限', detail: '当前账号不具备本场管理权限，或权限已经调整。', hideData: true };
  if (error?.status === 401) return { title: '登录或权限状态已失效', detail: '请重新核实登录状态后查看操作历史。', hideData: true };
  if (error?.status === 404) return { title: '无法查看这场安排', detail: '安排不存在，或当前账号无法读取。', hideData: true };
  if (error?.errorCode === 'CURSOR_EXPIRED') return { title: '历史分页已过期', detail: '将从第一页重新读取当前有权查看的事件。', hideData: true };
  return null;
}
