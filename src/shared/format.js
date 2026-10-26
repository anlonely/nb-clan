import { exportTimeZoneFor, localeFor } from '../i18n/languages.js';

const ERROR_MESSAGE_KEYS = {
  请求失败: 'requestFailed',
  服务器错误: 'serverError',
  '请求过于频繁，请稍后再试': 'errorTooManyRequests',
  请先登录: 'errorAuthRequired',
  需要管理员权限: 'errorAdminRequired',
  账号或密码错误: 'errorBadLogin',
  'Steam ID 必填': 'errorSteamRequired',
  '自定义 Steam 资料页需要在线解析': 'errorVanityNeedsOnline',
  '无法识别 SteamID，请输入 SteamID64、STEAM_X:Y:Z、[U:1:accountid] 或 Steam 资料页': 'errorSteamUnrecognized',
  '无法在线解析这个自定义 Steam 资料页，请改用 SteamID64': 'errorVanityFailed',
  '该 SteamID 已经是成员': 'errorDuplicateMember',
  '该 SteamID 已被其他账号绑定': 'errorSteamBoundToAccount',
  '该 SteamID 已被其他成员记录使用': 'errorSteamBelongsToMember',
  入队申请不存在: 'wechatJoinApplicationMissing',
  成员注册申请不存在: 'wechatJoinApplicationMissing',
  绑定申请不存在: 'wechatBindRequestMissing',
  微信用户不存在: 'wechatUserMissing',
  '当前微信账号已被限制使用': 'wechatUserBlocked',
  当前申请状态不能审核: 'wechatApplicationCannotReview',
  当前微信已绑定成员: 'wechatAlreadyBound',
  当前微信已绑定其他成员: 'wechatAlreadyBoundOther',
  该成员已绑定其他微信: 'wechatMemberAlreadyBound',
  该成员已有待审核绑定申请: 'wechatMemberBindRequestExists',
  审核状态无效: 'wechatInvalidReviewStatus',
  成员未绑定微信: 'wechatMemberNotBound',
  成员不存在: 'errorMemberMissing',
  提醒类型无效: 'requestFailed',
  未选择成员: 'errorNoMembersSelected',
  只能管理自己添加的成员: 'errorOwnMembersOnly',
  无权管理该成员: 'errorCannotManageMember',
  'Steam 资料更新失败': 'errorSteamProfileRefreshFailed',
  存在无权添加的成员: 'noPermission',
  '账号只能包含 2-32 位字母、数字、下划线、点和短横线': 'errorUsernameInvalid',
  '密码长度需要在 8-128 位之间': 'errorPasswordLength',
  '新密码长度需要在 8-128 位之间': 'errorNewPasswordLength',
  账号已存在: 'errorAccountExists',
  账号不存在: 'errorAccountMissing',
  '队长必须绑定 Steam ID': 'leaderSteamRequired',
  不能删除当前登录账号: 'errorCannotDeleteSelf',
  '不能删除 root 账号': 'errorCannotDeleteRoot',
  '不能修改 root 权限': 'errorCannotChangeRootRole',
  当前密码错误: 'errorCurrentPassword',
  需要队伍权限: 'noPermission',
  '只有 root 可以配置 API': 'noPermission',
  无权管理该队伍: 'noPermission',
  无权分配该队伍: 'noPermission',
  无权查看该队伍: 'noPermission',
  无权查看档期: 'noPermission',
  '无权查看 KDA': 'noPermission',
  '无权导出 KDA': 'noPermission',
  '当前档已结档，不可修改': 'closedReadonly',
  进行中的档期请先结档: 'closeWipeFirst',
  已经存在进行中的档期: 'activeWipeExists',
  档期不存在: 'noCurrentWipe',
  队伍不存在: 'noSquads',
  请选择有效队长: 'chooseLeaders',
  参与人员不存在: 'noParticipants',
  无权管理该参与人员: 'noPermission',
  存在无权添加的参与人员: 'noPermission',
  截图不存在: 'screenshot',
  截图格式不支持: 'screenshotHint',
  '截图不能超过 5MB': 'screenshotHint',
  地图资源不存在: 'mapAssets',
  地图文件格式不支持: 'mapFile',
  地图图片格式不支持: 'mapImage',
  '地图文件不能超过 20MB': 'mapUploadHint',
  参与状态不支持: 'participantStatus',
  'KDA 导入数据格式错误': 'kdaImportInvalid',
  'KDA 导入数据为空': 'kdaImportEmpty',
  '公开 API Token 尚未配置': 'publicApiTokenMissing',
  '公开 API Token 无效': 'publicApiTokenInvalid',
  'BattleMetrics API Key 尚未配置': 'battlemetricsApiKeyMissing',
  检测已停止: 'riskAlertDetectStopped',
  '当前服务器缺少 BattleMetrics Server ID': 'battlemetricsServerMissing',
  'BattleMetrics 未匹配到该 SteamID': 'battlemetricsNoMatch',
  'BattleMetrics 未匹配到该 SteamID 或昵称': 'battlemetricsNoMatch',
  'BattleMetrics 匹配到的 BM ID 已绑定其他成员': 'battlemetricsDuplicateId',
  'BattleMetrics 昵称搜索仅找到待人工复核候选': 'battlemetricsReviewRequired',
  'BattleMetrics API 被 Cloudflare 阻止，请稍后重试或配置可访问的代理': 'battlemetricsCloudflareBlocked',
  'NB_BATTLEMETRICS_PROXY_URL 格式无效': 'battlemetricsProxyInvalid',
  'NB_BATTLEMETRICS_PROXY_URL 只支持 http, https, socks4, socks5, socks5h': 'battlemetricsProxyInvalid',
  代理配置格式无效: 'proxyInvalid',
  '代理配置只支持 http, https, socks4, socks5, socks5h': 'proxyInvalid',
  代理作用范围无效: 'proxyScopeInvalid',
  '战队徽标 URL 无效': 'teamLogoInvalid',
  战队徽标图片格式不支持: 'teamLogoUploadInvalid',
  '战队徽标不能超过 2MB': 'teamLogoUploadTooLarge',
  计划档尚未开荒: 'wipeNotStarted',
  '等待 Vital 生成 Wipe ID': 'noKdaLink',
  '结束时间必须晚于开始时间': 'exportTimeInvalid',
  '时间范围最小 1 小时': 'exportTimeInvalid',
  服务器名称必填: 'serverName',
  队伍名称必填: 'squadName',
  'Vital VIP 购买日期必填': 'vitalVipPurchaseDateRequired',
  'Rustinity VIP 购买日期必填': 'rustinityVipPurchaseDateRequired',
  'Atlas VIP 购买日期必填': 'atlasVipPurchaseDateRequired'
};

function formatCopy(template, values = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_match, key) => values[key] ?? '');
}

function formatPublicLabel(label, value, lang) {
  return lang === 'zh' ? `${label}：${value}` : `${label}: ${value}`;
}

function localizeError(message, t) {
  const text = String(message || '').trim();
  if (!text) return t('requestFailed');
  if (/^Token 长度需要在 \\d+-\\d+ 位之间$/.test(text)) return t('publicApiTokenLength');
  if (/^BattleMetrics API Key 长度需要在 \\d+-\\d+ 位之间$/.test(text)) return t('battlemetricsApiKeyLength');
  const directTranslation = t(text);
  if (directTranslation !== text) return directTranslation;
  const key = ERROR_MESSAGE_KEYS[text];
  return key ? t(key) : text;
}

function formatApiError(error, t) {
  const message = localizeError(error?.message, t);
  const status = Number(error?.status || 0);
  return status ? `HTTP ${status} · ${message}` : message;
}

function displayDataValue(value, t) {
  const text = String(value || '').trim();
  if (!text || text === '未知') return t('unknown');
  if (text === 'anonymous') return t('anonymous');
  return text;
}

function datetimeLocalToIso(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function datetimeLocalInputValue(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    return '';
  }
}

function formatTime(value, lang = 'zh') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: exportTimeZoneFor(lang),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatDateTimeWithYear(value, lang = 'zh') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: exportTimeZoneFor(lang),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatBrowserTime(value, lang = 'zh') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(lang), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatBrowserDateTimeWithYear(value, lang = 'zh') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(localeFor(lang), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function localDateInputValue(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateRangeIso(dateValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ''))) return null;
  const [year, month, day] = dateValue.split('-').map((item) => Number(item));
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function latestTimestamp(items = [], picker = (item) => item) {
  const latestMs = items.reduce((latest, item) => {
    const value = picker(item);
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
  return latestMs ? new Date(latestMs).toISOString() : '';
}

function formatShortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

function formatStatNumber(value, lang = 'zh', options = {}) {
  return new Intl.NumberFormat(localeFor(lang), { maximumFractionDigits: 0, ...options }).format(Number(value || 0));
}

function formatBytes(value, lang = 'zh') {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${formatStatNumber(size, lang, { maximumFractionDigits: size >= 100 || unitIndex === 0 ? 0 : 1 })} ${units[unitIndex]}`;
}

function formatCompactResource(value, lang = 'zh') {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return '0';
  const sign = numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);
  if (abs < 10000) return `${sign}${formatStatNumber(abs, lang)}`;
  const scaled = abs / 10000;
  const maximumFractionDigits = scaled < 100 ? 2 : 1;
  return `${sign}${formatStatNumber(scaled, lang, { maximumFractionDigits })}w`;
}

function formatPlayTimeMinutes(minutes, lang = 'zh') {
  const value = Number(minutes || 0);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const hours = value / 60;
  return `${formatStatNumber(hours, lang, { maximumFractionDigits: hours < 100 ? 1 : 0 })} h`;
}

function battlemetricsPlayTimeMinutes(profileStats = {}, scope = 'server') {
  const battlemetrics = profileStats?.battlemetrics || {};
  const minutesKey = scope === 'total' ? 'totalPlayTimeMinutes' : 'serverPlayTimeMinutes';
  const secondsKey = scope === 'total' ? 'totalPlayTimeSeconds' : 'serverPlayTimeSeconds';
  const minutes = Number(battlemetrics[minutesKey] || 0);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const seconds = Number(battlemetrics[secondsKey] || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : 0;
}

function localDateTimeInputValue(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function startOfLocalDayInputValue(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return localDateTimeInputValue(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0));
}

function calculateWipePlayDays(wipe, fallbackEnd = new Date()) {
  const started = new Date(wipe?.startedAt || '');
  const ended = new Date(wipe?.closedAt || fallbackEnd);
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()) || ended <= started) return 0;
  return Number(((ended.getTime() - started.getTime()) / 86_400_000).toFixed(1));
}

function formatPlayDays(days, lang = 'zh') {
  return formatStatNumber(days, lang, { maximumFractionDigits: days > 0 && days < 10 ? 1 : 0 });
}


export {
  battlemetricsPlayTimeMinutes,
  browserTimeZone,
  calculateWipePlayDays,
  datetimeLocalInputValue,
  datetimeLocalToIso,
  displayDataValue,
  formatApiError,
  formatBrowserDateTimeWithYear,
  formatBrowserTime,
  formatBytes,
  formatCompactResource,
  formatCopy,
  formatDateTimeWithYear,
  formatPlayDays,
  formatPlayTimeMinutes,
  formatPublicLabel,
  formatShortDate,
  formatStatNumber,
  formatTime,
  latestTimestamp,
  localDateInputValue,
  localDateRangeIso,
  localizeError,
  startOfLocalDayInputValue
};
