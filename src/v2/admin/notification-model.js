import { resolveLocalTime } from '../../../server/v2/scheduling/time.js';

export const purposeLabels = { signup_open: '报名通知', reminder: '开荒提醒', schedule_changed: '安排变更', signup_closed: '报名截止', cancelled: '取消通知', result: '结束结果' };
export const deliveryLabels = { queued: '已加入投递队列', sending: '正在投递', sent: '已发送', retry_wait: '等待重试', failed: '已知未送达', delivery_unknown: '送达结果未知', cancelled: '已取消投递' };
export const intentLabels = { queued: '已加入投递队列', running: '正在投递', completed: '全部已发送', partial_failure: '部分失败', failed: '投递失败', needs_attention: '需要核实', cancelled: '已取消' };
export const languageLabels = { 'zh-CN': '简体中文', en: 'English', ru: 'Русский', tr: 'Türkçe', th: 'ไทย', ko: '한국어' };
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const notificationFingerprint = value => JSON.stringify(canonical(value));
const unique = values => [...new Set(values)].sort();
function requireValue(condition, message, field) {
  if (!condition) { const error = new Error(message); error.field = field; throw error; }
}

export function createNotificationForm(wipe, options, { delivery = null, intent = null, purposeInstance } = {}) {
  return { purpose: intent?.purpose || options.allowedPurposes?.[0] || 'signup_open',
    purposeInstance: delivery ? purposeInstance || globalThis.crypto.randomUUID() : 'primary',
    repeatOfIntentId: delivery?.intentId || null, reason: '', duplicateRiskAcknowledged: false,
    targets: delivery ? [{ targetId: delivery.targetId, language: delivery.language, mentionMode: 'none', roleIds: [] }] : [],
    audience: clone(wipe.audience), scheduleMode: 'now', dueAtLocal: '', expiresAtLocal: '', utcOffset: '' };
}

// Input is derived from current authoritative options and wipe DTO, never a prototype target list.
export function buildNotificationInput(form, wipe, options, { now = Date.now(), repeatDelivery = null } = {}) {
  const template = options.templates?.find(row => row.id === 'wipe-notification' && row.revision === 1);
  requireValue(template, '当前没有可用的正式通知模板。', 'template');
  requireValue(options.allowedPurposes?.includes(form.purpose) && template.purposes.includes(form.purpose), '当前不允许使用这个通知用途。', 'purpose');
  requireValue(form.targets?.length > 0 && form.targets.length <= 20, '请选择 1 至 20 个频道和语言组合。', 'targets');
  const seen = new Set();
  const targets = form.targets.map(selection => {
    const target = options.targets.find(row => row.id === selection.targetId);
    requireValue(target?.enabled && target.capabilities.preview, '频道已停用或当前无预览权限。', 'targets');
    requireValue(target.languages.includes(selection.language) && template.languages.includes(selection.language) && Object.hasOwn(languageLabels, selection.language), '所选频道不支持这个语言。', 'targets');
    const key = `${selection.targetId}\u0000${selection.language}`;
    requireValue(!seen.has(key), '同一个频道和语言不能重复选择。', 'targets'); seen.add(key);
    requireValue(['none', 'roles', 'everyone'].includes(selection.mentionMode), '请选择有效的提醒范围。', 'mentionMode');
    const roleIds = unique(selection.roleIds || []);
    if (selection.mentionMode === 'roles') {
      requireValue(target.capabilities.mentionRoles && roleIds.length > 0 && roleIds.every(id => target.roleOptions.some(role => role.id === id)), '没有提醒该角色的权限，或角色已不在允许列表。', 'roleIds');
    } else requireValue(roleIds.length === 0, '不提醒或提醒全员时不能附带角色。', 'roleIds');
    requireValue(selection.mentionMode !== 'everyone' || target.capabilities.mentionEveryone, '没有提醒全员的权限。', 'mentionMode');
    return { targetId: target.id, language: selection.language, mentionMode: selection.mentionMode, roleIds };
  }).sort((a,b) => a.targetId.localeCompare(b.targetId) || a.language.localeCompare(b.language));
  const audience = { ...(form.audience?.allMembers===true?{allMembers:true}:{}), squadIds: unique(form.audience?.squadIds || []), memberIds: unique(form.audience?.memberIds || []), includeUnassigned: Boolean(form.audience?.includeUnassigned) };
  requireValue((!audience.allMembers||wipe.audience.allMembers===true) && (wipe.audience.allMembers===true || (audience.squadIds.every(id => wipe.audience.squadIds.includes(id)) && audience.memberIds.every(id => wipe.audience.memberIds.includes(id)) && (!audience.includeUnassigned || wipe.audience.includeUnassigned))), '通知受众不能超出这场安排的报名范围。', 'audience');
  let schedule = null;
  if (form.scheduleMode === 'scheduled') {
    const resolve = localDateTime => resolveLocalTime({ localDateTime, timeZone: wipe.timeZone, ...(form.utcOffset ? { utcOffset: form.utcOffset } : {}) });
    schedule = { dueAt: resolve(form.dueAtLocal), expiresAt: resolve(form.expiresAtLocal) };
    requireValue(Date.parse(schedule.dueAt) > now && Date.parse(schedule.expiresAt) > Date.parse(schedule.dueAt), '发送时间必须晚于现在，失效时间必须晚于发送时间。', 'schedule');
  } else requireValue(form.scheduleMode === 'now', '请选择立即发送或定时发送。', 'schedule');
  if (repeatDelivery) {
    requireValue(repeatDelivery.wipeId === wipe.id && repeatDelivery.intentId === form.repeatOfIntentId && repeatDelivery.actions?.repeat, '原投递当前不允许再次通知，请返回核实。', 'repeat');
    requireValue(form.purposeInstance !== 'primary' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(form.purposeInstance), '再次通知必须有独立的意图标识。', 'repeat');
    requireValue(form.reason.trim(), '请填写再次通知的原因。', 'reason');
    requireValue(repeatDelivery.status !== 'delivery_unknown' || form.duplicateRiskAcknowledged === true, '原消息可能已送达，请明确确认可能重复后再预览。', 'duplicateRiskAcknowledged');
    requireValue(targets.length === 1 && targets[0].targetId === repeatDelivery.targetId && targets[0].language === repeatDelivery.language, '再次通知保留原目标和语言，请从普通通知入口创建其他目标的通知。', 'targets');
  } else requireValue(form.purposeInstance === 'primary' && form.repeatOfIntentId === null && !form.duplicateRiskAcknowledged, '普通通知不能携带再次通知参数。', 'repeat');
  return { expectedContentRevision: wipe.contentRevision, templateId: template.id, templateRevision: template.revision,
    purpose: form.purpose, purposeInstance: form.purposeInstance, repeatOfIntentId: form.repeatOfIntentId,
    reason: form.reason.trim() || null, duplicateRiskAcknowledged: Boolean(form.duplicateRiskAcknowledged), targets, audience, schedule };
}

export function previewInvalidReason(preview, input, wipe, options, { now = Date.now(), previewInput = null } = {}) {
  if (!preview) return '请先生成正式预览。';
  if (Date.parse(preview.expiresAt) <= now || !Number.isFinite(Date.parse(preview.expiresAt))) return '这份预览已过期，请重新生成。';
  if (preview.wipeId !== wipe.id || preview.contentRevision !== wipe.contentRevision || preview.wipeRevision !== wipe.revision) return '安排已经更新，请重新预览。';
  if (!input || previewInput && notificationFingerprint(input) !== notificationFingerprint(previewInput)) return '通知选项已变更，请重新预览。';
  if (preview.targets.some(row => { const current = options.targets.find(t => t.id === row.target.id);
    return !current?.enabled || !current.capabilities.preview || current.configurationRevision !== row.target.configurationRevision; })) return '频道配置或权限已变化，请重新预览。';
  return null;
}

export function publishIntentInput(preview) {
  return { previewId: preview.id, contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
    purpose: preview.purpose, purposeInstance: preview.purposeInstance };
}

export const deliveryNeedsPolling = (delivery, operations = []) => Boolean(delivery && ['queued', 'sending', 'retry_wait', 'delivery_unknown'].includes(delivery.status) || operations.some(row => ['queued', 'running'].includes(row.status)));
export const intentNeedsPolling = intent => Boolean(intent && ['queued', 'sending', 'retry_wait', 'delivery_unknown'].some(status => intent.counts[status] > 0));
export const pollDelay = failureCount => Math.min(30_000, 3_000 * 2 ** Math.max(0, failureCount));

export function buildReconcileInput(delivery, { decision, reason = '', evidence = '', messageRef = null }) {
  requireValue(delivery.status === 'delivery_unknown', '只有送达结果未知的投递可以核实。', 'decision');
  requireValue(['request_lookup', 'confirmed_sent', 'confirmed_not_sent'].includes(decision), '请选择核实方式。', 'decision');
  requireValue(decision === 'request_lookup' ? delivery.actions.lookup : delivery.actions.reconcile, '当前没有执行这项核实的权限。', 'decision');
  requireValue(reason.trim(), '请填写核实原因。', 'reason');
  if (decision !== 'request_lookup') requireValue(evidence.trim(), '人工判定必须填写可追溯的核实证据。', 'evidence');
  if (decision === 'confirmed_sent') {
    requireValue(messageRef && messageRef.platform === delivery.platform && ['guildId', 'channelId', 'messageId'].every(key => typeof messageRef[key] === 'string' && messageRef[key].trim()), '确认已送达时，请提供匹配目标的服务器、频道和消息 ID。', 'messageRef');
    requireValue(messageRef.messageUrl === null || /^https:\/\//.test(messageRef.messageUrl), '消息链接须为平台返回的 HTTPS 链接，也可以留空。', 'messageRef');
  }
  return { expectedRevision: delivery.revision, decision, reason: reason.trim(), evidence: evidence.trim(), messageRef: decision === 'confirmed_sent' ? clone(messageRef) : null };
}

export function notificationError(error) {
  return ({ PREVIEW_EXPIRED: '预览已过期，请重新预览后确认。', PREVIEW_STALE: '安排、受众或频道配置已更新，请重新预览。',
    REVISION_CONFLICT: '这项记录已在其他页面更新，请重新读取并确认当前状态。', IDEMPOTENCY_CONFLICT: '这次操作与已保存的请求不一致，请先核实原操作。',
    NOTIFICATION_AUDIENCE_DENIED: '没有查看或通知所选受众的权限。', ACCESS_DENIED: '当前账号没有执行这项通知操作的权限。',
    DELIVERY_NOT_RETRYABLE: '当前投递不属于已知未送达，不能重试。', DELIVERY_NOT_CANCELLABLE: '当前投递不能取消，发送中取消也不代表未送达。',
    DELIVERY_NOT_UNKNOWN: '这项投递已有确定结果，请重新读取。', DELIVERY_REFERENCE_REQUIRED: '请提供匹配目标的真实消息引用。',
    DUPLICATE_RISK_NOT_ACKNOWLEDGED: '需要明确确认消息可能重复。', NOTIFICATION_SETUP_REQUIRED: '通知服务尚未接入，无法创建通知。',
    ISOLATED_TRANSPORT_REQUIRED: '隔离投递服务未配置，请联系本地集成人员。', LANGUAGE_UNSUPPORTED: '目标不支持所选语言。',
    MENTION_INVALID: '提醒范围或角色不在允许范围。', SCHEDULE_INVALID: '请检查定时发送与失效时间。',
    NOTIFICATION_INPUT_INVALID: '通知参数无效，请核对后重新预览。', TARGET_INVALID: '目标频道已失效或不允许使用。',
    TEMPLATE_UNSUPPORTED: '通知模板不受支持。', TEMPLATE_REVISION_UNSUPPORTED: '通知模板版本已变化。', REASON_REQUIRED: '请填写操作原因。',
  })[error?.errorCode] || error?.message;
}
