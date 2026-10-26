const { readCommand, avatarDisplayUrl } = require('../../../services/api');
const { hours, date, text, specialties, specialtyTags, signupLabel } = require('../../../utils/presentation');
const { access, goLink } = require('../../../utils/page');
const emptyMember = () => ({ specialtyTags: [], rustTotalText: '—', officialRows: [], currentServers: [], recentWipes: [] });
function decorateMember(member = {}) {
  const official = member.official || {};
  const labels = { kills: '击杀', deaths: '死亡', kd: 'KD', rockets: '火箭弹', sulfur: '硫磺', metalOre: '金属矿' };
  return { ...member, specialtiesText: specialties(member.specialties), specialtyTags: specialtyTags(member.specialties), rustTotalText: hours(member.rustTotalMinutes), officialAvailable: ['available', 'stale'].includes(official.status), officialStale: official.status === 'stale', officialUpdatedAt: official.updatedAt ? date(official.updatedAt) : '', officialRows: Object.keys(labels).map(key => ({ key, label: labels[key], value: text(official.values?.[key], '—') })), currentServers: (member.currentServers || []).map(item => ({ ...item, startsAtText: date(item.startsAt) })), recentWipes: (member.recentWipes || []).slice(0, 3).map(item => ({ ...item, startsAtText: date(item.startsAt), endedAtText: date(item.endedAt), responseText: signupLabel(item) })) };
}
Page({
  data: { linked: false, loading: false, errorText: '', wechat: null, wechatAvatar: '', member: emptyMember() },
  onShow() { this.active = true; this.load(); },
  onHide() { this.active = false; this.sequence = (this.sequence || 0) + 1; this.setData({ loading: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  goLink,
  editWechat() { wx.navigateTo({ url: '/pages/gate/index/index?edit=1' }); },
  async load() {
    if (this.data.loading) return;
    const sequence = this.sequence = (this.sequence || 0) + 1;
    this.setData({ linked: false, loading: true, errorText: '', wechat: null, wechatAvatar: '', member: emptyMember() });
    try {
      const profile = await access(this);
      if (!profile?.linked || !this.active || sequence !== this.sequence) return;
      this.setData({ wechat: profile });
      const [avatar, home] = await Promise.all([avatarDisplayUrl(profile), readCommand('member_home')]);
      if (this.active && sequence === this.sequence) this.setData({ wechatAvatar: avatar, member: home?.member ? decorateMember(home.member) : emptyMember() });
    } catch (error) { if (this.active && sequence === this.sequence) this.setData({ errorText: error.message }); }
    finally { if (sequence === this.sequence) this.setData({ loading: false }); }
  }
});
