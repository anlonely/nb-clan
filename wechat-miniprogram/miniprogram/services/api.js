const { apiOrigin: API_ORIGIN } = require('../config.js');
const API_BASE = `${API_ORIGIN}/api/v2/mini-program`;
const SESSION_KEY = 'nb_wechat_v2_session';
let session = wx.getStorageSync(SESSION_KEY) || null;
let loginPromise = null;
let avatarCache = null;
let communityAvatarCache = null;
const inflight = new Map();
const errorMessages = {
  WECHAT_PROFILE_APP_CONFLICT: '旧微信资料所属小程序无法确认，请联系网站管理员核对配置',
  WECHAT_PROFILE_REQUIRED: '请先完善微信头像和昵称', WECHAT_PROFILE_NICKNAME_INVALID: '昵称须为 1 至 32 个字符',
  WECHAT_LINK_EXPIRED: '关联凭证已过期，请重新获取', WECHAT_LINK_NOT_FOUND: '关联凭证不存在或已失效，请重新获取',
  WECHAT_LINK_CONFIG_CHANGED: '关联配置已更新，请重新获取关联凭证', WECHAT_LINK_ACCOUNT_CHANGED: '官网账号信息已变化，请重新关联',
  WECHAT_LINK_ACCOUNT_CONFLICT: '该战队账号已关联其他微信，请联系管理员', WECHAT_LINK_WECHAT_CONFLICT: '当前微信已关联其他战队账号，请联系管理员',
  WECHAT_LINK_ALREADY_LINKED: '微信已关联，请刷新查看', WECHAT_LINK_CONSUMED: '关联凭证已使用，请刷新查看',
  WECHAT_LINK_CLAIMED: '该关联凭证已被其他账号使用，请重新获取', WECHAT_LINK_NOT_READY: '请先在官网使用 KOOK 完成确认',
  WECHAT_LINK_KOOK_REQUIRED: '请先在官网通过 KOOK 登录战队账号', WECHAT_LINK_STEAM_REQUIRED: '请先在官网完成 Steam 身份关联',
  WECHAT_LINK_CODE_INVALID: '请输入正确的 8 位关联码', WECHAT_LINK_QR_INVALID: '请扫描官网关联微信页面的二维码',
  WECHAT_LINK_RATE_LIMITED: '关联操作太频繁，请稍后再试', WECHAT_LINK_CAPACITY: '关联服务繁忙，请稍后再试',
  MINI_PROGRAM_NOT_CONFIGURED: '小程序服务暂未开放，请稍后重试',
  MINI_SESSION_INVALID: '登录已过期，请重试', MINI_SESSION_REVOKED: '登录已更新，请重试',
  IDENTITY_BINDING_REQUIRED: '请先关联你的 KOOK 战队账号', MINI_PROFILE_REQUIRED: '请先完善微信头像和昵称',
  ACCESS_DENIED: '当前账号没有查看权限', MEMBERSHIP_INACTIVE: '当前成员状态不可报名',
  MEMBER_VERIFICATION_REQUIRED: '请先在官网完成成员身份关联',
  SIGNUP_CLOSED: '报名已截止', SIGNUP_NOT_OPEN: '报名尚未开始', WIPE_IMMUTABLE: '该档期已结束，不能再修改报名',
  ARRIVAL_TIME_INVALID: '预计到达时间须晚于开荒时间和当前时间',
  SIGNUP_REVISION_CONFLICT: '报名状态已变化，请刷新后重新选择', CONTENT_REVISION_CONFLICT: '开荒安排已变化，请刷新并确认新安排',
  SIGNUP_CONFLICT: '报名状态已变化，请刷新后重试', WIPE_CONTENT_CHANGED: '开荒安排已变化，请刷新后重试',
  MINI_LINK_EXPIRED: '关联凭证已过期，请重新获取', MINI_LINK_INVALID: '关联凭证无效，请重新获取',
  IDENTITY_CONFLICT: '账号已有关联，无法重复绑定', PLATFORM_UNAVAILABLE: '服务暂时不可用，请稍后重试',
  RESOURCE_NOT_FOUND: '内容已不存在，请刷新', MINI_LINK_NOT_READY: '请先在官网使用 KOOK 完成确认',
  MINI_LINK_CONFLICT: '该账号已关联其他微信，请联系管理员', KOOK_IDENTITY_REQUIRED: '请在官网登录 KOOK 后继续'
};
function operationId() { return `mini_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`; }
function apiUrl(path) { return /^https:\/\//.test(path || '') ? path : `${API_ORIGIN}${path || ''}`; }
function saveSession(payload) {
  if (payload?.token) { session = payload; wx.setStorageSync(SESSION_KEY, payload); avatarCache = null; communityAvatarCache = null; }
  return payload;
}
function clearSession() { session = null; avatarCache = null; communityAvatarCache = null; wx.removeStorageSync(SESSION_KEY); }
function normalizeError(error, statusCode) {
  const detail = error?.error || error || {};
  const code = detail.errorCode || detail.code || '';
  const message = errorMessages[code] || (statusCode === 409 ? '数据已变化，请刷新后重试' : statusCode === 429 ? '操作太频繁，请稍后再试' : statusCode === 403 ? '当前账号暂不能进行此操作' : '请求失败，请稍后重试');
  return Object.assign(new Error(message), { code, statusCode, current: detail.current || null });
}
function request(path, { method = 'GET', data, token = session?.token, key, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}${path}`, method, data, timeout,
      header: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      success(result) {
        if (result.statusCode >= 200 && result.statusCode < 300 && !result.data?.error) resolve(result.data?.data);
        else reject(normalizeError(result.data, result.statusCode));
      },
      fail(error) { reject(Object.assign(new Error(/timeout/i.test(error?.errMsg || '') ? '连接超时，请重试' : '网络连接失败，请重试'), { code: 'NETWORK_ERROR' })); }
    });
  });
}
async function login() {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const code = await new Promise((resolve, reject) => wx.login({ success: result => result.code ? resolve(result.code) : reject(new Error('微信登录失败，请重试')), fail: () => reject(new Error('微信登录失败，请重试')) }));
    return saveSession(await request('/login', { method: 'POST', data: { code, clientVersion: 2 }, token: '' }));
  })();
  try { return await loginPromise; } finally { loginPromise = null; }
}
async function ensureSession() {
  if (!session?.token || Date.parse(session.expiresAt || '') <= Date.now() + 5000) await login();
  return session;
}
async function authenticated(path, options = {}) {
  await ensureSession();
  try { return await request(path, options); }
  catch (error) {
    if (error.statusCode !== 401) throw error;
    clearSession(); await login();
    return request(path, options);
  }
}
async function getWechatProfile() { return authenticated('/profile'); }
async function saveWechatProfile({ nickName }) { return authenticated('/profile', { method: 'PUT', data: { nickName }, key: operationId() }); }
async function avatarDisplayUrl(profile = {}) {
  if (!profile.avatarUrl) return '';
  if (avatarCache?.token === session?.token) return avatarCache.path;
  await ensureSession();
  return new Promise(resolve => wx.downloadFile({
    url: `${API_BASE}/profile/avatar`, header: { Authorization: `Bearer ${session.token}` },
    success(result) {
      if (result.statusCode === 200 && result.tempFilePath) { avatarCache = { token: session.token, path: result.tempFilePath }; resolve(result.tempFilePath); }
      else resolve('');
    }, fail: () => resolve('')
  }));
}
async function communityAvatarDisplayUrl(provider, sourceUrl) {
  if (provider !== 'kook' || !sourceUrl) return '';
  await ensureSession();
  const token = session.token;
  if (communityAvatarCache?.token === token && communityAvatarCache.sourceUrl === sourceUrl && communityAvatarCache.expiresAt > Date.now()) return communityAvatarCache.path;
  // KOOK rejects WeChat image Referers. The authenticated endpoint selects the
  // current account's own guild icon; sourceUrl is only a local cache key.
  return new Promise(resolve => wx.downloadFile({
    url: `${API_BASE}/community-avatar/kook`, header: { Authorization: `Bearer ${token}` }, timeout: 10000,
    success(result) {
      const path = result.statusCode === 200 && result.tempFilePath ? result.tempFilePath : '';
      if (path && session?.token === token) communityAvatarCache = { token, sourceUrl, path, expiresAt: Date.now() + 60000 };
      resolve(session?.token === token ? path : '');
    }, fail: () => resolve('')
  }));
}
async function uploadWechatAvatar(filePath) {
  const info = await new Promise((resolve, reject) => wx.getImageInfo({ src: filePath, success: resolve, fail: () => reject(new Error('无法读取头像，请重新选择')) }));
  const scale = Math.min(1, 512 / Math.max(info.width, info.height));
  let path = filePath;
  if (wx.compressImage) path = await new Promise(resolve => wx.compressImage({ src: filePath, quality: 75, compressedWidth: Math.round(info.width * scale), compressedHeight: Math.round(info.height * scale), success: result => resolve(result.tempFilePath), fail: () => resolve(filePath) }));
  const base64 = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: result => resolve(result.data), fail: () => reject(new Error('无法读取头像，请重新选择')) }));
  if (base64.length * 3 / 4 > 1024 * 1024) throw new Error('头像过大，请选择较小图片');
  const actual = await new Promise((resolve, reject) => wx.getImageInfo({ src: path, success: resolve, fail: reject }));
  if (actual.width > 1024 || actual.height > 1024) throw new Error('头像尺寸过大，请选择较小图片');
  const mime = ({ png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg' })[String(actual.type || '').toLowerCase()];
  if (!mime) throw new Error('请选择 PNG、JPEG 或 WebP 头像');
  const profile = await authenticated('/profile/avatar', { method: 'POST', data: { dataUrl: `data:${mime};base64,${base64}` }, key: operationId(), timeout: 30000 });
  avatarCache = null;
  return profile;
}
async function ensureCanEnterApp() {
  const profile = await getWechatProfile();
  if (profile.complete) return profile;
  wx.reLaunch({ url: '/pages/gate/index/index' });
  return null;
}
function command(name, input = {}, { key = operationId() } = {}) { return authenticated(`/commands/${encodeURIComponent(name)}`, { method: 'POST', data: input, key }); }
function readCommand(name, input = {}) {
  const cacheKey = `${session?.token || ''}:${name}:${JSON.stringify(input)}`;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const promise = command(name, input).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, promise); return promise;
}
const createLinkCode = () => authenticated('/link/code', { method: 'POST', data: {}, key: operationId() });
const getLinkStatus = linkId => authenticated(`/link/status?linkId=${encodeURIComponent(linkId)}`);
const scanLink = token => authenticated('/link/scan', { method: 'POST', data: { token }, key: operationId() });
async function confirmLink(linkId) { return saveSession(await authenticated('/link/confirm', { method: 'POST', data: { linkId }, key: operationId() })); }
async function submitWipeSignup(wipe, response, expectedArrivalAt = null, key = operationId()) {
  if (!Number.isSafeInteger(wipe?.contentRevision) || !Number.isSafeInteger(wipe?.mySignup?.signupRevision)) throw new Error('请刷新档期后再报名');
  return authenticated('/signup', { method: 'POST', key, data: { kind: 'direct-v2', adapterVersion: 2, wipeId: wipe.id, input: { response, expectedArrivalAt: response === 'attending_later' ? expectedArrivalAt : null, timeZone: 'Asia/Shanghai', expectedSignupRevision: wipe.mySignup.signupRevision, confirmedContentRevision: wipe.contentRevision } } });
}
module.exports = { API_ORIGIN, operationId, apiUrl, login, ensureSession, getWechatProfile, saveWechatProfile, avatarDisplayUrl, communityAvatarDisplayUrl, uploadWechatAvatar, ensureCanEnterApp, command, readCommand, createLinkCode, getLinkStatus, scanLink, confirmLink, submitWipeSignup };
