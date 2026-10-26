const { readCommand } = require('../../../services/api');
const { date } = require('../../../utils/presentation');
const { access, goLink } = require('../../../utils/page');
const metrics = [{ key: 'kd', label: 'KD' }, { key: 'kills', label: '击杀' }, { key: 't3Kills', label: 'T3 击杀' }, { key: 'deaths', label: '死亡' }, { key: 'onlineSeconds', label: '在线时长' }, { key: 'rockets', label: '火箭弹' }, { key: 'sulfur', label: '硫磺' }, { key: 'metalOre', label: '金属矿' }, { key: 'building', label: '建筑' }];
function displayValue(value, metric) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  if (metric === 'onlineSeconds' || metric === 'playTimeSeconds') return `${(Number(value) / 3600).toFixed(1)} 小时`;
  return metric === 'kd' ? Number(value).toFixed(2) : String(Math.round(Number(value)));
}
Page({
  data: { linked: false, loading: false, loadingMore: false, errorText: '', metrics, metric: 'kd', metricLabel: 'KD', wipes: [], wipeId: '', wipeIndex: 0, items: [], updatedAtText: '', total: 0, hasMore: false },
  onShow() { this.active = true; this.load(); },
  onHide() { this.active = false; this.loadSequence = (this.loadSequence || 0) + 1; this.sequence = (this.sequence || 0) + 1; this.setData({ loading: false, loadingMore: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  onReachBottom() { if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) this.fetch(false); },
  goLink,
  async load() {
    const loadSequence = this.loadSequence = (this.loadSequence || 0) + 1;
    this.sequence = (this.sequence || 0) + 1;
    this.setData({ linked: false, loading: true, loadingMore: false, errorText: '', items: [], total: 0, hasMore: false, wipes: [], wipeId: '', wipeIndex: 0, updatedAtText: '' });
    try { const profile = await access(this); if (loadSequence !== this.loadSequence || !this.active) return; if (!profile?.linked) { this.setData({ items: [] }); return; } await this.fetch(true); }
    catch (error) { if (this.active && loadSequence === this.loadSequence) this.setData({ errorText: error.message }); }
    finally { if (this.active && loadSequence === this.loadSequence) this.setData({ loading: false }); }
  },
  async fetch(reset = true) {
    if (!this.active || !this.data.linked) return;
    const sequence = this.sequence = (this.sequence || 0) + 1;
    const metric = this.data.metric;
    this.setData({ loading: reset, loadingMore: !reset, errorText: '' });
    try {
      const payload = await readCommand('member_rankings', { ...(this.data.wipeId ? { wipeId: this.data.wipeId } : {}), metric, offset: reset ? 0 : this.data.items.length, limit: 40 });
      if (!this.active || sequence !== this.sequence) return;
      const incoming = (payload.items || []).map(item => ({ ...item, displayValue: displayValue(item.value, metric) }));
      const items = reset ? incoming : [...this.data.items, ...incoming];
      const wipes = payload.wipes || [];
      this.setData({ items, wipes, wipeId: payload.wipeId || '', wipeIndex: Math.max(0, wipes.findIndex(w => w.id === payload.wipeId)), updatedAtText: payload.updatedAt ? date(payload.updatedAt) : '', total: payload.total || 0, hasMore: items.length < (payload.total || 0) });
    } catch (error) { if (this.active && sequence === this.sequence) this.setData({ errorText: error.message, ...(reset ? { items: [], hasMore: false } : {}) }); }
    finally { if (this.active && sequence === this.sequence) this.setData({ loading: false, loadingMore: false }); }
  },
  selectMetric(event) {
    const metric = metrics.find(item => item.key === event.currentTarget.dataset.key);
    if (!metric || metric.key === this.data.metric) return;
    this.setData({ metric: metric.key, metricLabel: metric.label }); this.fetch(true);
  },
  selectWipe(event) { const wipeIndex = Number(event.detail.value); this.setData({ wipeIndex, wipeId: this.data.wipes[wipeIndex]?.id || '' }); this.fetch(true); }
});
