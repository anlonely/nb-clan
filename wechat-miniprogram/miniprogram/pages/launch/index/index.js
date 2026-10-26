const { ensureCanEnterApp } = require('../../../services/api');
Page({
  data: { entering: false, errorText: '' },
  onShow() { this.enterBase(); },
  async enterBase() {
    if (this.data.entering) return;
    this.setData({ entering: true, errorText: '' });
    try { if (await ensureCanEnterApp()) wx.switchTab({ url: '/pages/link/index/index' }); }
    catch (error) { this.setData({ errorText: error.message || '暂时无法进入，请重试' }); }
    finally { this.setData({ entering: false }); }
  }
});
