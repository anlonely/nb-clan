const { API_ORIGIN, ensureCanEnterApp, readCommand, communityAvatarDisplayUrl, createLinkCode, getLinkStatus, scanLink, confirmLink } = require('../../../services/api');
const { date, parseLinkQr, roleTags } = require('../../../utils/presentation');
const LINK_KEY = 'nb_wechat_v2_link';
function identities(items = []) {
  return ['steam', 'kook', 'discord'].map(provider => {
    const item = items.find(identity => identity.provider === provider) || {};
    const linked = Boolean(item.externalId), isCommunity = provider !== 'steam';
    const title = { steam: 'Steam', kook: 'KOOK', discord: 'Discord' }[provider];
    const accountName = typeof item.displayName === 'string' && item.displayName !== item.externalId ? item.displayName.trim() : '';
    const sourceRoles = Array.isArray(item.roles) ? item.roles : [];
    const roles = roleTags(sourceRoles.filter(role => typeof role.name === 'string' && role.name.trim() && role.name !== String(role.id)));
    const pendingRoles = sourceRoles.length - roles.length;
    const rolesNotes = [];
    if (linked && isCommunity) {
      if (pendingRoles) rolesNotes.push(`${pendingRoles} 个角色名待同步`);
      if (item.rolesStatus === 'stale') rolesNotes.push('角色信息较旧，等待同步');
      else if (!sourceRoles.length) rolesNotes.push(item.rolesStatus === 'fresh' ? '暂无服务器角色' : '暂无已同步角色');
    }
    return { ...item, provider, title, isCommunity, linked,
      statusText: item.status === 'unverified' ? '待验证' : linked ? '已关联' : '未关联',
      displayName: linked ? accountName || (isCommunity ? '账号名称待同步' : 'Steam 昵称待同步') : '尚未关联', accountName,
      communityName: linked ? item.communityName || '暂无服务器资料' : '尚未关联',
      communityNote: linked && item.communityStatus === 'stale' ? '服务器资料较旧，等待同步' : '',
      displayAvatar: provider === 'kook' ? '' : isCommunity ? item.communityAvatarUrl || '' : item.avatarUrl || '',
      avatarPlaceholder: title.slice(0, 1), roles, rolesNote: rolesNotes.join(' · ') };
  });
}
Page({
  data: { loading: false, errorText: '', linked: false, identities: identities(), roles: [], link: null, checking: false, creating: false, confirming: false, scanning: false },
  onShow() { this.active = true; this.load(); },
  onHide() { this.active = false; this.loadSequence = (this.loadSequence || 0) + 1; this.checkSequence = (this.checkSequence || 0) + 1; this.stopPolling(); this.setData({ loading: false, checking: false }); },
  onUnload() { this.onHide(); },
  avatarError(event) { const provider = event.currentTarget.dataset.provider; this.setData({ identities: this.data.identities.map(item => item.provider === provider ? { ...item, displayAvatar: '' } : item) }); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  async applyHome(home, isCurrent) {
    const items = identities(home.identities);
    this.setData({ identities: items, roles: roleTags(home.member?.roles || []), link: null });
    const kook = items.find(item => item.provider === 'kook' && item.linked && item.communityAvatarUrl);
    if (!kook) return;
    try {
      const path = await communityAvatarDisplayUrl('kook', kook.communityAvatarUrl);
      if (path && this.active && isCurrent()) this.setData({ identities: this.data.identities.map(item =>
        item.provider === 'kook' && item.externalId === kook.externalId && item.communityAvatarUrl === kook.communityAvatarUrl ? { ...item, displayAvatar: path } : item) });
    } catch (_) { /* Optional guild images never block account information. */ }
  },
  async load() {
    if (this.data.loading) return;
    const sequence = this.loadSequence = (this.loadSequence || 0) + 1;
    this.setData({ loading: true, errorText: '' });
    try {
      const profile = await ensureCanEnterApp();
      if (!profile || !this.active || sequence !== this.loadSequence) return;
      this.setData({ linked: profile.linked });
      if (profile.linked) {
        this.stopPolling(); wx.removeStorageSync(LINK_KEY);
        const home = await readCommand('member_home');
        if (this.active && sequence === this.loadSequence) await this.applyHome(home, () => sequence === this.loadSequence);
      } else {
        const saved = wx.getStorageSync(LINK_KEY);
        if (saved?.linkId && Date.parse(saved.expiresAt) > Date.now()) { this.setData({ link: saved }); await this.checkStatus(); this.startPolling(); }
        else { wx.removeStorageSync(LINK_KEY); this.setData({ link: null }); }
      }
    } catch (error) { if (this.active && sequence === this.loadSequence) this.setData({ errorText: error.message }); }
    finally { if (sequence === this.loadSequence) this.setData({ loading: false }); }
  },
  applyLink(payload) {
    const link = { ...(this.data.link || {}), ...payload, expiresAtText: date(payload.expiresAt || this.data.link?.expiresAt) };
    this.setData({ link }); wx.setStorageSync(LINK_KEY, link);
  },
  async createCode() {
    if (this.data.creating) return;
    this.setData({ creating: true, errorText: '' });
    try { this.setData({ link: null }); this.applyLink(await createLinkCode()); this.startPolling(); }
    catch (error) { this.setData({ errorText: error.message }); }
    finally { this.setData({ creating: false }); }
  },
  copyWebsite() { wx.setClipboardData({ data: `${API_ORIGIN}/app/wechat-link` }); },
  copyCode() { if (this.data.link?.code) wx.setClipboardData({ data: this.data.link.code }); },
  startPolling() { this.stopPolling(); if (this.active && this.data.link?.linkId) this.timer = setInterval(() => this.checkStatus({ silent: true }), 5000); },
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = null; },
  async checkStatus(options = {}) {
    if (!this.data.link?.linkId || this.data.checking || this.data.confirming || this.data.creating || this.data.scanning) return;
    const linkId = this.data.link.linkId;
    const sequence = this.checkSequence = (this.checkSequence || 0) + 1;
    if (Date.parse(this.data.link.expiresAt) <= Date.now()) {
      this.stopPolling(); wx.removeStorageSync(LINK_KEY); this.setData({ link: null, errorText: '关联凭证已过期，请重新获取' }); return;
    }
    this.setData({ checking: true, ...(!options.silent ? { errorText: '' } : {}) });
    try {
      const payload = await getLinkStatus(linkId);
      if (!this.active || sequence !== this.checkSequence || this.data.link?.linkId !== linkId) return;
      if (payload.status === 'linked') {
        this.stopPolling(); wx.removeStorageSync(LINK_KEY); this.setData({ linked: true, link: null });
        const home = await readCommand('member_home');
        if (this.active && sequence === this.checkSequence) await this.applyHome(home, () => sequence === this.checkSequence);
      } else this.applyLink(payload);
    }
    catch (error) {
      if (!this.active || sequence !== this.checkSequence || this.data.link?.linkId !== linkId) return;
      const invalid = error.statusCode === 410 || ['WECHAT_LINK_EXPIRED', 'WECHAT_LINK_NOT_FOUND', 'WECHAT_LINK_CONFIG_CHANGED', 'WECHAT_LINK_ACCOUNT_CHANGED', 'WECHAT_LINK_CLAIMED', 'WECHAT_LINK_CONSUMED'].includes(error.code);
      if (invalid) { this.stopPolling(); wx.removeStorageSync(LINK_KEY); this.setData({ link: null, errorText: error.message }); }
      else if (!options.silent) this.setData({ errorText: error.message });
    }
    finally { if (sequence === this.checkSequence) this.setData({ checking: false }); }
  },
  async scan() {
    if (this.data.scanning) return;
    this.setData({ scanning: true, errorText: '' });
    try {
      const result = await new Promise((resolve, reject) => wx.scanCode({ onlyFromCamera: true, scanType: ['qrCode'], success: resolve, fail: reject }));
      const payload = await scanLink(parseLinkQr(result.result));
      this.setData({ link: null }); this.applyLink(payload); this.startPolling();
    } catch (error) { if (!/cancel/i.test(error.errMsg || '')) this.setData({ errorText: error.message || '扫码失败，请重试' }); }
    finally { this.setData({ scanning: false }); }
  },
  async confirm() {
    if (this.data.confirming || this.data.link?.status !== 'awaiting_confirmation') return;
    this.setData({ confirming: true, errorText: '' });
    try {
      await confirmLink(this.data.link.linkId);
      this.stopPolling(); wx.removeStorageSync(LINK_KEY); this.setData({ link: null });
      wx.showToast({ title: '关联成功', icon: 'success' }); await this.load();
    } catch (error) { this.setData({ errorText: error.message }); }
    finally { this.setData({ confirming: false }); }
  }
});
