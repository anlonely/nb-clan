export function wipeStatusText(status, t) {
  if (status === 'closed') return t('statusClosed');
  if (status === 'planned') return t('statusPlanned');
  return t('statusActive');
}

export function managedWipeOptionForForm(options = [], form = {}, nowMs = Date.now()) {
  const selectable = (Array.isArray(options) ? options : [])
    .filter((option) => option?.type === 'current' || option?.type === 'next');
  const exact = selectable.find((option) => option.type === form?.wipeMode);
  if (exact) return exact;

  const startedAtMs = Date.parse(form?.startedAt || '');
  if (Number.isFinite(startedAtMs) && startedAtMs > nowMs) {
    return selectable.find((option) => option.type === 'next') || selectable[0] || null;
  }
  return selectable.find((option) => option.type === 'current') || selectable[0] || null;
}
