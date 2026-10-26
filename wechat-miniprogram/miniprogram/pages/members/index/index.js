const { readCommand } = require('../../../services/api');
const { member, specialtyTags } = require('../../../utils/presentation');
const { access, goLink } = require('../../../utils/page');
Page({
  data: { linked: false, loading: false, loadingMore: false, errorText: '', items: [], squads: [{ id: '', name: '全部队伍' }], squadIndex: 0,
    specialtyOptions: [{ id: '', label: '全部专长' }], specialtyIndex: 0, query: '', total: 0, hasMore: false },
  onShow() { this.active = true; this.load(); },
  onHide() { this.active = false; this.loadSequence = (this.loadSequence || 0) + 1; this.sequence = (this.sequence || 0) + 1; clearTimeout(this.searchTimer); this.setData({ loading: false, loadingMore: false }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  onReachBottom() { if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) this.fetch(false); },
  goLink,
  async load() {
    const loadSequence = this.loadSequence = (this.loadSequence || 0) + 1;
    this.sequence = (this.sequence || 0) + 1;
    this.setData({ linked: false, loading: true, loadingMore: false, errorText: '', items: [], total: 0, hasMore: false, squads: [{ id: '', name: '全部队伍' }], squadIndex: 0, specialtyOptions: [{ id: '', label: '全部专长' }], specialtyIndex: 0 });
    try { const profile = await access(this); if (loadSequence !== this.loadSequence || !this.active) return; if (!profile?.linked) { this.setData({ items: [] }); return; } await this.fetch(true); }
    catch (error) { if (this.active && loadSequence === this.loadSequence) this.setData({ errorText: error.message }); }
    finally { if (this.active && loadSequence === this.loadSequence) this.setData({ loading: false }); }
  },
  async fetch(reset = true) {
    if (!this.active || !this.data.linked) return;
    const sequence = this.sequence = (this.sequence || 0) + 1;
    const offset = reset ? 0 : this.data.items.length;
    this.setData({ loading: reset, loadingMore: !reset, errorText: '' });
    try {
      const selectedSquad = this.data.squads[this.data.squadIndex]?.id || '';
      const selectedSpecialty = this.data.specialtyOptions[this.data.specialtyIndex]?.id || '';
      const payload = await readCommand('member_directory', { q: this.data.query.trim(), squadId: selectedSquad, ...(selectedSpecialty ? { specialty: selectedSpecialty } : {}), offset, limit: 40 });
      if (!this.active || sequence !== this.sequence) return;
      const incoming = (payload.items || []).map(item => ({ ...member(item), specialtyTags: specialtyTags(item.specialties) }));
      const items = reset ? incoming : [...this.data.items, ...incoming];
      const squads = [{ id: '', name: '全部队伍' }, ...(payload.squads || [])];
      const specialtyOptions = [{ id: '', label: '全部专长' }, ...(payload.specialtyOptions || [])];
      this.setData({ items, squads, specialtyOptions, specialtyIndex: Math.max(0, specialtyOptions.findIndex(s => s.id === selectedSpecialty)),
        squadIndex: Math.max(0, squads.findIndex(s => s.id === selectedSquad)), total: payload.total || 0, hasMore: items.length < (payload.total || 0) });
    } catch (error) { if (this.active && sequence === this.sequence) this.setData({ errorText: error.message }); }
    finally { if (this.active && sequence === this.sequence) this.setData({ loading: false, loadingMore: false }); }
  },
  search(event) { this.sequence = (this.sequence || 0) + 1; this.setData({ query: event.detail.value }); clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.fetch(true), 350); },
  selectSquad(event) { clearTimeout(this.searchTimer); this.setData({ squadIndex: Number(event.detail.value) }); return this.fetch(true); },
  selectSpecialty(event) { clearTimeout(this.searchTimer); this.setData({ specialtyIndex: Number(event.detail.value) }); return this.fetch(true); },
  copySteamId(event) { const steamId = String(event.currentTarget.dataset.steamid || '').trim(); if (steamId) wx.setClipboardData({ data: steamId }); }
});
