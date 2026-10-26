const { getWechatProfile, saveWechatProfile, uploadWechatAvatar, avatarDisplayUrl } = require('../../../services/api');
Page({
  data: { nickName: '', avatarUrl: '', avatarFile: '', hasAvatar: false, loading: false, saving: false, errorText: '', privacyReady: false, showPrivacy: false, privacyContractName: '《用户隐私保护指引》', editing: false },
  onLoad(options = {}) {
    this.setData({ editing: options.edit === '1' });
    this.privacyHandler = resolve => { this.privacyResolve = resolve; this.setData({ showPrivacy: true, privacyReady: false }); };
    if (wx.onNeedPrivacyAuthorization) wx.onNeedPrivacyAuthorization(this.privacyHandler);
    this.checkPrivacy();
    this.load();
  },
  onUnload() {
    if (this.privacyResolve) this.privacyResolve({ event: 'disagree' });
    this.privacyResolve = null;
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, errorText: '' });
    try {
      const profile = await getWechatProfile();
      if (profile.complete && !this.data.editing) { wx.switchTab({ url: '/pages/link/index/index' }); return; }
      this.setData({ nickName: profile.nickName || '', hasAvatar: Boolean(profile.avatarUrl), avatarUrl: await avatarDisplayUrl(profile) });
    } catch (error) { this.setData({ errorText: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  checkPrivacy() {
    if (!wx.getPrivacySetting) { this.setData({ privacyReady: true }); return; }
    wx.getPrivacySetting({ success: result => this.setData({ privacyReady: !result.needAuthorization, showPrivacy: Boolean(result.needAuthorization), privacyContractName: result.privacyContractName || this.data.privacyContractName }), fail: () => this.setData({ errorText: '暂时无法读取隐私授权状态，请重试', showPrivacy: true }) });
  },
  openPrivacy() { if (wx.openPrivacyContract) wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂不可用', icon: 'none' }) }); },
  showPrivacy() { this.setData({ showPrivacy: true }); },
  agreePrivacy(event) {
    if (this.privacyResolve) this.privacyResolve({ event: 'agree', buttonId: event.currentTarget.id });
    this.privacyResolve = null; this.setData({ privacyReady: true, showPrivacy: false, errorText: '' });
  },
  rejectPrivacy() {
    if (this.privacyResolve) this.privacyResolve({ event: 'disagree' });
    this.privacyResolve = null; this.setData({ privacyReady: false, showPrivacy: false });
  },
  chooseAvatar(event) { if (!this.data.privacyReady) { this.showPrivacy(); return; } this.setData({ avatarFile: event.detail.avatarUrl, avatarUrl: event.detail.avatarUrl }); },
  nicknameInput(event) { this.setData({ nickName: event.detail.value }); },
  async save() {
    if (this.data.saving || this.data.loading) return;
    if (!this.data.privacyReady) { this.showPrivacy(); return; }
    const nickName = this.data.nickName.trim();
    if (!nickName || (!this.data.avatarFile && !this.data.hasAvatar)) { this.setData({ errorText: '请选择头像并填写昵称' }); return; }
    this.setData({ saving: true, errorText: '' });
    try {
      let profile = await saveWechatProfile({ nickName });
      if (this.data.avatarFile) profile = await uploadWechatAvatar(this.data.avatarFile);
      if (!profile.complete) throw new Error('头像和昵称尚未保存完整，请重试');
      wx.switchTab({ url: this.data.editing ? '/pages/mine/index/index' : '/pages/link/index/index' });
    } catch (error) { this.setData({ errorText: error.message }); }
    finally { this.setData({ saving: false }); }
  }
});
