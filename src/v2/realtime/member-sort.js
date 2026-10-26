export const defaultMemberSort = { key: 'lastOnlineAt', direction: 'desc' };

const rank = (member, key) => {
  if (key === 'relationship') return `${member.registered ? '0' : '1'} ${member.squadName || ''} ${member.gameClanName || ''}`;
  if (key === 'status') return member.online === true ? 0 : member.online === false ? 1 : null;
  const at = Date.parse(member[key] || '');
  return Number.isFinite(at) ? at : null;
};

export function sortRealtimeMembers(members, sort = defaultMemberSort) {
  const { key, direction } = sort;
  const factor = direction === 'asc' ? 1 : -1;
  return [...members].sort((a, b) => {
    const left = rank(a, key), right = rank(b, key);
    if (left === null) return right === null ? String(a.displayName || a.steamId).localeCompare(String(b.displayName || b.steamId), 'zh-Hans-CN') : 1;
    if (right === null) return -1;
    const result = typeof left === 'number' ? left - right : left.localeCompare(right, 'zh-Hans-CN');
    return result ? result * factor : String(a.displayName || a.steamId).localeCompare(String(b.displayName || b.steamId), 'zh-Hans-CN');
  });
}

export function nextMemberSort(current, key) {
  return current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : {
    key,
    direction: key === 'relationship' || key === 'status' ? 'asc' : 'desc'
  };
}
