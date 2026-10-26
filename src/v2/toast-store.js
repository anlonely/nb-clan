export function createToastStore({ durationMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let items = [], sequence = 0;
  const listeners = new Set(), timers = new Map(), seen = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  function dismiss(id) {
    clearTimer(timers.get(id)); timers.delete(id);
    if (!items.some(item => item.id === id)) return;
    items = items.filter(item => item.id !== id); emit();
  }
  function show(message = '保存成功', { id: operationId } = {}) {
    if (operationId && seen.has(operationId)) return;
    if (operationId) {
      seen.add(operationId);
      if (seen.size > 200) seen.delete(seen.values().next().value);
    }
    const id = ++sequence;
    if (items.length === 3) dismiss(items[0].id);
    items = [...items, { id, message }];
    timers.set(id, setTimer(() => dismiss(id), durationMs)); emit();
    return id;
  }
  function clear() {
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear(); seen.clear(); items = []; emit();
  }
  return { show, dismiss, clear, getSnapshot: () => items,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}

export const successToasts = createToastStore();
export const notifySuccess = (message, options) => successToasts.show(message, options);
