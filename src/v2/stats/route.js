export function statsWorkspaceParams(current, values) {
  const next = new URLSearchParams(current);
  next.delete('cursor');
  if (Object.hasOwn(values, 'wipe') && values.wipe !== current.get('wipe')) {
    next.delete('revision');
    next.delete('hb');
  }
  if (Object.hasOwn(values, 'hidden')) next.delete('wc');
  for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
  return next;
}
