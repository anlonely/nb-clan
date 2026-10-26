import { t, dateLocale } from './i18n.js';
import { displayTimeZone } from './display-preferences.js';
import { resolveLocalTime } from '../../server/v2/scheduling/time.js';
export const responseLabel = { attending_on_time: '准时到', attending_later: '晚些到', not_attending: '这次不来' };
export const lifecycleLabel = { draft: '草稿', scheduled: '即将开始', active: '进行中', ended: '已结束', archived: '已归档', cancelled: '已取消' };
export function time(value, zone = displayTimeZone(), short = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return t("待确认");
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: zone, month: '2-digit', day: '2-digit', ...(short ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
export function localInput(value, zone = displayTimeZone()) {
  if (!value) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(new Date(value)).map(p => [p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function arrivalTime(localDateTime, timeZone, utcOffset) { return resolveLocalTime({ localDateTime, timeZone, ...(utcOffset ? { utcOffset } : {}) }); }
export const errorCopy = error => {
  const wait = Number(error?.retryAfterSeconds);
  if (['KOOK_RATE_LIMITED', 'KOOK_BUSY', 'AUTH_RATE_LIMITED', 'STEAM_RATE_LIMITED'].includes(error?.errorCode || error?.code))
    return Number.isFinite(wait) && wait > 0
      ? t('请求较多，请等待 {seconds} 秒后重试。', { seconds: Math.ceil(wait) })
      : t('请求较多，请稍后重试。');
  return ({
  PAGE_RESOURCES_UNAVAILABLE: t("页面可能已更新，或网络连接暂时中断。恢复连接后可重新加载页面。"),
  CLIENT_VERSION_UNSUPPORTED: t("页面版本与服务不兼容，请重新加载页面后再操作。"),
  AUTH_REFRESH_REQUIRED:t("登录已返回，暂时无法核实会话，请重新检查登录状态。"),
  AUTH_REQUIRED:t("请先登录，再继续查看原来的页面。"), SESSION_EXPIRED:t("登录已过期，请重新登录。"), SESSION_INVALID:t("登录已失效，请重新登录。"),
  PERMISSIONS_CHANGED:t("成员权限发生变化，请重新登录核实。"), ELIGIBILITY_DENIED:t("暂未获得战队准入角色，请联系管理员后重新检查。"),
  MEMBER_DEPARTED:t("你已离队，请联系管理获取语音频道角色"),
  ELIGIBILITY_UNAVAILABLE:t("暂时无法核实社区角色，请稍后重新检查。"), AUTH_CONTEXT_EXPIRED:t("这次登录已过期，请重新开始。"),
  KOOK_UNAVAILABLE:t('KOOK 暂时无法完成验证，请稍后重新登录。'),
  STEAM_UNAVAILABLE:t('Steam 暂时无法确认账号，请稍后重新验证。'),
  AUTH_CANCELLED:t("你已取消授权，可以重新选择登录。"), AUTH_INVALID_CALLBACK:t("这次授权无法继续，请在原浏览器重新登录。"),
  IDENTITY_CONFLICT:t("账号关联需要管理员核实，已有资料和绑定已保留。"), MEMBER_VERIFICATION_REQUIRED:t("请先完成 Steam 验证。"),
  STEAM_ACCOUNT_NOT_LINKED:t("此 Steam 尚未关联已有账号，请先使用战队平台登录或联系管理员。"),
  MEMBERSHIP_INACTIVE:t("当前成员状态不允许参加，请联系队长。"), MEMBER_OUTSIDE_AUDIENCE:t("这场开荒不在你的报名范围内。"),
  RESOURCE_NOT_FOUND:t("没有找到这项安排，或当前账号无权查看。"), ACCESS_DENIED:t("当前账号没有访问权限。"),
  SIGNUP_CLOSED:t("报名已经截止。需要临时调整，请联系队长。"), SIGNUP_NOT_OPEN:t("报名尚未开放，请留意报名时间。"), WIPE_IMMUTABLE:t("这场开荒已结束或取消，回复不能再修改。"),
  ARRIVAL_TIME_INVALID:t("晚到时间需要晚于开荒时间，且不能早于现在。"), TIME_AMBIGUOUS:t("这个时间遇到夏令时回拨，请选择明确的 UTC 偏移。"), TIME_NONEXISTENT:t("这个当地时间因夏令时调整不存在，请另选时间。"),
  TIME_ZONE_INVALID:t("请选择有效时区。"), TIME_INPUT_INVALID:t("请选择完整的到场日期和时间。"),
  REVISION_CONFLICT:t("回复已在其他地方修改，请刷新最新回复后再编辑。"),
  IDEMPOTENCY_CONFLICT:t("这次操作与原请求不一致，请重新核实当前结果。"), CSRF_INVALID:t("页面验证已过期，请重新登录后继续。"),
  AUTH_INVALID_CREDENTIALS:t("账号或密码不正确。"), PLATFORM_LOGIN_REQUIRED:t("请使用战队平台登录此成员账号。"),
  NETWORK_ERROR:t("网络连接中断，请恢复连接后重试。"), REQUEST_TIMEOUT:t("连接较慢，暂时没有收到服务器结果。"),
  PROFILE_FIELD_FORBIDDEN:t("包含不允许修改的资料字段。"), PROFILE_INVALID:t("请检查昵称、专长和时区填写。"),
}[error?.errorCode || error?.code] || (navigator.onLine === false ? t("网络已断开，请恢复连接后重试。") : t("暂时无法完成，请稍后重试。")));
};
