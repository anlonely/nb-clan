const { formatUtc8Time } = require('./time');

function managedWipeOptionLabel(option = {}) {
  const prefix = option.type === 'next' ? '下一个 Wipe' : (option.type === 'current' ? '当前' : (option.label || 'Wipe'));
  const formatted = option.startedAt ? formatUtc8Time(option.startedAt, { fallback: '' }).slice(0, 16) : '';
  return [prefix, formatted].filter(Boolean).join(' · ');
}

function managedWipeOptionIndex(options = [], selection = {}, { preferNext = false, nowMs = Date.now() } = {}) {
  const selectable = Array.isArray(options) ? options : [];
  const selectedId = String(selection.vitalWipeId || selection.id || '');
  if (selectedId) {
    const byId = selectable.findIndex((option) => option.vitalWipeId === selectedId || option.id === selectedId);
    if (byId >= 0) return byId;
  }
  const mode = String(selection.wipeMode || '');
  if (mode === 'current' || mode === 'next') {
    const byMode = selectable.findIndex((option) => option.type === mode);
    if (byMode >= 0) return byMode;
  }
  const startedAtMs = Date.parse(selection.startedAt || '');
  if (Number.isFinite(startedAtMs) && startedAtMs > nowMs) {
    const nextIndex = selectable.findIndex((option) => option.type === 'next');
    if (nextIndex >= 0) return nextIndex;
  }
  if (preferNext) {
    const nextIndex = selectable.findIndex((option) => option.type === 'next');
    if (nextIndex >= 0) return nextIndex;
  }
  const currentIndex = selectable.findIndex((option) => option.type === 'current');
  return currentIndex >= 0 ? currentIndex : 0;
}

module.exports = {
  managedWipeOptionIndex,
  managedWipeOptionLabel
};
