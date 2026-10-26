const { readCommand, submitWipeSignup, operationId } = require('../../../services/api');
const { wipe: decorateWipe, arrivalIso, date, signupLabel, specialtyTags } = require('../../../utils/presentation');
const { access, goLink } = require('../../../utils/page');
function participant(item) {
  return { ...item, name: item.name || '成员', initial: (item.name || '成员').slice(0, 1), squadName: item.squadName || '未分队',
    statusText: signupLabel(item), arrivalText: item.expectedArrivalAt ? date(item.expectedArrivalAt) : '' };
}
Page({
  data: { linked: false, loading: false, errorText: '', items: [], selectedIndex: 0, current: null, arrivalDate: '', arrivalTime: '', submitting: false, resultText: '',
    participantItems: [], participantCounts: null, participantRegionCounts: null, participantTotal: 0, participantsLoading: false, participantsError: '', participantsCursor: null, participantUpdatedText: '', selectedParticipant: null },
  onShow() { this.active = true; this.load(); },
  onHide() { this.active = false; this.loadSequence = (this.loadSequence || 0) + 1; this.wipesSequence = (this.wipesSequence || 0) + 1; this.participantsSequence = (this.participantsSequence || 0) + 1; this.setData({ loading: false, participantsLoading: false, selectedParticipant: null }); },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  goLink,
  async load() {
    if (this.data.loading || this.data.submitting) return;
    const sequence = this.loadSequence = (this.loadSequence || 0) + 1;
    this.wipesSequence = (this.wipesSequence || 0) + 1;
    this.pendingMutation = null;
    this.setData({ linked: false, loading: true, errorText: '', resultText: '', items: [], selectedIndex: 0 });
    this.applyCurrent(null);
    try {
      const profile = await access(this);
      if (!this.active || sequence !== this.loadSequence) return;
      if (!profile?.linked) { this.setData({ items: [] }); this.applyCurrent(null); return; }
      await this.refreshWipes();
    } catch (error) { if (this.active && sequence === this.loadSequence) this.setData({ errorText: error.message }); }
    finally { if (sequence === this.loadSequence) this.setData({ loading: false }); }
  },
  async refreshWipes() {
    if (!this.active || !this.data.linked) return;
    const sequence = this.wipesSequence = (this.wipesSequence || 0) + 1;
    const payload = await readCommand('member_wipes');
    if (!this.active || sequence !== this.wipesSequence) return;
    const previousId = this.data.current?.id;
    const items = (payload.items || []).map(decorateWipe);
    const selectedIndex = Math.max(0, items.findIndex(item => item.id === previousId));
    this.setData({ items, selectedIndex });
    await this.applyCurrent(items[selectedIndex] || null);
  },
  applyCurrent(current) {
    this.participantsSequence = (this.participantsSequence || 0) + 1;
    this.participantsRevision = null;
    const arrival = current?.mySignup?.expectedArrivalAt || current?.startsAt;
    const formatted = arrival ? date(arrival) : date(new Date().toISOString());
    this.setData({ current, arrivalDate: formatted.slice(0, 10), arrivalTime: formatted.slice(11, 16),
      participantItems: [], participantCounts: null, participantRegionCounts: null, participantTotal: 0, participantsLoading: false, participantsError: '', participantsCursor: null, participantUpdatedText: '', selectedParticipant: null });
    if (current && this.active) return this.loadParticipants(true);
  },
  selectWipe(event) {
    if (this.data.submitting || this.data.loading) return;
    const selectedIndex = Number(event.detail.value);
    this.pendingMutation = null;
    this.setData({ selectedIndex, resultText: '', errorText: '' });
    return this.applyCurrent(this.data.items[selectedIndex] || null);
  },
  refreshParticipants() { return this.loadParticipants(true); },
  loadMoreParticipants() { return this.loadParticipants(false); },
  openParticipant(event) {
    const item = this.data.participantItems.find(row => row.memberId === event.currentTarget.dataset.memberId);
    if (!item) return;
    this.setData({ selectedParticipant: { ...item, specialtyTags: specialtyTags(item.specialties || []) } });
  },
  closeParticipant() { this.setData({ selectedParticipant: null }); },
  keepParticipantOpen() {},
  copyParticipantSteamId() {
    const steamId = this.data.selectedParticipant?.steamId;
    if (typeof steamId === 'string' && /^\d{17}$/.test(steamId)) wx.setClipboardData({ data: steamId });
  },
  copyServerInfo(event) {
    if (!this.data.linked) return;
    const field = event.currentTarget.dataset.field;
    if (!['connectCommand', 'mapUrl'].includes(field)) return;
    const value = this.data.current?.[field];
    if (typeof value === 'string' && value.trim()) wx.setClipboardData({ data: value });
  },
  async loadParticipants(reset = false) {
    const wipeId = this.data.current?.id;
    if (!this.active || !this.data.linked || !wipeId || (!reset && (this.data.participantsLoading || !this.data.participantsCursor))) return;
    const sequence = this.participantsSequence = (this.participantsSequence || 0) + 1;
    const cursor = reset ? '' : this.data.participantsCursor;
    this.setData({ participantsLoading: true, participantsError: '', ...(reset ? { participantItems: [], participantCounts: null, participantRegionCounts: null, participantTotal: 0, participantsCursor: null, selectedParticipant: null } : {}) });
    try {
      const payload = await readCommand('member_wipe_participants', { wipeId, limit: 30, cursor });
      if (!this.active || sequence !== this.participantsSequence || this.data.current?.id !== wipeId) return;
      if (payload.wipeId !== wipeId || !payload.counts || !Array.isArray(payload.items)) throw new Error('报名名单暂时无法读取，请重试。');
      if (!reset && this.participantsRevision !== payload.rosterRevision) return this.loadParticipants(true);
      this.participantsRevision = payload.rosterRevision;
      const combined = reset ? payload.items : [...this.data.participantItems, ...payload.items];
      const items = [...new Map(combined.map(item => [item.memberId, participant(item)])).values()];
      this.setData({ participantItems: items, participantCounts: payload.counts, participantRegionCounts: payload.regionCounts || null, participantTotal: payload.total,
        participantsCursor: payload.nextCursor || null,
        participantUpdatedText: payload.evaluatedAt ? date(payload.evaluatedAt) : '' });
    } catch (error) {
      if (this.active && sequence === this.participantsSequence && this.data.current?.id === wipeId) this.setData({ participantsError: error.message || '报名名单加载失败，请重试。' });
    } finally { if (sequence === this.participantsSequence) this.setData({ participantsLoading: false }); }
  },
  arrivalDate(event) { this.setData({ arrivalDate: event.detail.value }); },
  arrivalTime(event) { this.setData({ arrivalTime: event.detail.value }); },
  async signup(event) {
    const current = this.data.current, sequence = this.loadSequence;
    if (!this.data.linked || this.data.submitting || this.data.loading || !current?.canSignup) return;
    const response = event.currentTarget.dataset.response;
    if (!['attending_on_time', 'attending_later', 'not_attending'].includes(response)) return;
    let arrival = null;
    try {
      if (response === 'attending_later') {
        arrival = arrivalIso(this.data.arrivalDate, this.data.arrivalTime);
        if (Date.parse(arrival) <= Date.now()) throw new Error('预计到达时间应晚于当前时间');
        if (Date.parse(arrival) <= Date.parse(current.serverStartsAt || current.startsAt || '')) throw new Error('预计到达时间应晚于开荒时间');
      }
    } catch (error) { this.setData({ errorText: error.message }); return; }
    const fingerprint = JSON.stringify([current.id, current.contentRevision, current.mySignup?.signupRevision, response, arrival]);
    if (this.pendingMutation?.fingerprint !== fingerprint) this.pendingMutation = { fingerprint, key: operationId() };
    this.setData({ submitting: true, errorText: '', resultText: '' });
    try {
      const result = await submitWipeSignup(current, response, arrival, this.pendingMutation.key);
      if (!this.active || !this.data.linked || sequence !== this.loadSequence) return;
      this.pendingMutation = null;
      if (result.current) {
        const next = decorateWipe({ ...current, mySignup: result.current });
        const items = this.data.items.map(item => item.id === next.id ? next : item);
        this.setData({ current: next, items });
      }
      this.setData({ resultText: '报名状态已保存。' });
      try { await this.refreshWipes(); }
      catch (_) { this.setData({ errorText: '报名操作已保存，列表暂时刷新失败。下拉刷新可查看最新状态。' }); }
    } catch (error) {
      if (!this.active || !this.data.linked || sequence !== this.loadSequence) return;
      if (error.statusCode === 409) {
        this.pendingMutation = null;
        try { await this.refreshWipes(); } catch (_) {}
        this.setData({ errorText: '开荒安排或报名状态已变化，请核对当前内容后重新选择。' });
      } else this.setData({ errorText: error.message });
    } finally { this.setData({ submitting: false }); }
  }
});
