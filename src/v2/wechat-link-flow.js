import { t } from './i18n.js';
import { ApiError } from './query-client.js';

export const WECHAT_LINK_RETURN_TO = '/app/wechat-link';
export const WECHAT_LINK_LOGIN_URL = `/api/v2/auth/kook/start?returnTo=${encodeURIComponent(WECHAT_LINK_RETURN_TO)}`;
export const normalizeWechatLinkCode = value => String(value || '').replace(/\s/g, '');
export const validWechatLinkCode = value => /^\d{8}$/.test(normalizeWechatLinkCode(value));
export const wechatLinkExpired = (challenge, now = Date.now()) => Boolean(challenge &&
  (!Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= now));
export const validWechatLinkQrPayload = value => typeof value === 'string' && /^nbclan:wechat-link:[A-Za-z0-9_-]{43,128}$/.test(value);

// The website only prepares a link. The final identity mutation belongs to the
// signed-in mini-program, after its owner has seen and confirmed the target.
export function createWechatLinkFlow({ client, onChange, now = Date.now }) {
  let state = Object.freeze({ challenge: null, error: null, busy: false, mode: null });
  let sequence = 0, controller = null, disposed = false, polling = false;
  const publish = patch => { state = Object.freeze({ ...state, ...patch }); onChange(state); };
  async function run(path, options, { mode = state.mode, poll = false } = {}) {
    if (disposed || state.busy || poll && polling) return null;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, ticket = ++sequence, generation = client.getGeneration();
    polling = poll;
    const current = () => !disposed && ticket === sequence && !signal.aborted && generation === client.getGeneration();
    publish({ error: null, mode, busy: !poll, ...(!poll ? { challenge: null } : {}) });
    try {
      const result = await client.request(path, { ...options, signal });
      if (!current()) return null;
      const challenge = result.data;
      if (!challenge?.linkId || !['pending', 'awaiting_confirmation', 'linked', 'expired', 'cancelled'].includes(challenge.status) ||
          !Number.isFinite(Date.parse(challenge.expiresAt))) throw new ApiError('INVALID_RESPONSE');
      if (mode === 'qr' && !poll && !validWechatLinkQrPayload(challenge.qrPayload)) throw new ApiError('INVALID_RESPONSE');
      publish({ challenge: { ...(poll ? state.challenge : {}), ...challenge }, error: null });
      return challenge;
    } catch (error) {
      if (current()) publish({ error, ...(poll && error.errorCode === 'WECHAT_LINK_EXPIRED' ? { challenge: { ...state.challenge, status: 'expired' } } : {}) });
      return null;
    } finally {
      if (ticket === sequence) polling = false;
      if (current()) publish({ busy: false });
    }
  }
  return {
    getState: () => state,
    claim(value) {
      if (disposed || state.busy) return Promise.resolve(null);
      const code = normalizeWechatLinkCode(value);
      if (!validWechatLinkCode(code)) { publish({ error: new ApiError('WECHAT_LINK_CODE_INVALID') }); return Promise.resolve(null); }
      return run('/api/v2/wechat-link/claim', { method: 'POST', body: { code } }, { mode: 'code' });
    },
    qr: () => run('/api/v2/wechat-link/qr', { method: 'POST', body: {} }, { mode: 'qr' }),
    poll() {
      const challenge = state.challenge;
      if (!challenge || !['pending', 'awaiting_confirmation'].includes(challenge.status) || wechatLinkExpired(challenge, now())) return Promise.resolve(null);
      return run(`/api/v2/wechat-link/status?linkId=${encodeURIComponent(challenge.linkId)}`, {}, { poll: true });
    },
    reset() {
      if (disposed) return;
      sequence++; polling = false; controller?.abort(); publish({ challenge: null, error: null, busy: false, mode: null });
    },
    dispose() { disposed = true; sequence++; controller?.abort(); }
  };
}

export function wechatLinkError(error) {
  return ({
    WECHAT_LINK_CODE_INVALID: t("请输入小程序显示的 8 位数字关联码。"),
    WECHAT_LINK_NOT_FOUND: t("关联码不存在或已失效，请在小程序重新获取。"),
    WECHAT_LINK_EXPIRED: t("关联已过期，请重新获取关联码或刷新二维码。"),
    WECHAT_LINK_KOOK_REQUIRED: t("请使用已关联 KOOK 的成员账号登录后再继续。"),
    WECHAT_LINK_STEAM_REQUIRED: t("请先按官网登录流程完成 Steam 身份验证。"),
    WECHAT_LINK_CONFLICT: t("此微信或成员账号已有其他关联，请先核实账号。"),
    WECHAT_LINK_WECHAT_CONFLICT: t("这个微信已关联其他成员账号，请核实后再操作。"),
    WECHAT_LINK_ACCOUNT_CONFLICT: t("当前成员账号已关联其他微信，请先核实原关联。"),
    WECHAT_LINK_ACCOUNT_CHANGED: t("成员账号状态已变化，请重新登录并发起关联。"),
    WECHAT_LINK_CONFIG_CHANGED: t("关联设置已更新，请重新获取关联码或生成二维码。"),
    WECHAT_LINK_CLAIMED: t("关联请求已被使用，请返回小程序核对待确认账号。"),
    WECHAT_LINK_CONSUMED: t("本次关联已完成，请返回小程序查看。"),
    WECHAT_LINK_ALREADY_CLAIMED: t("关联码已被使用，请返回小程序核对待确认账号。"),
    WECHAT_LINK_ALREADY_LINKED: t("微信已有关联，请返回小程序查看。"),
    WECHAT_LINK_RATE_LIMITED: t("尝试次数较多，请稍后重新操作。")
  })[error?.errorCode];
}
