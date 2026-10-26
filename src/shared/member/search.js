const memberSearchTextCache = new WeakMap();

export function normalizedMemberSearchQuery(query) {
  return String(query || '').trim().toLowerCase();
}

export function memberSearchText(member = {}) {
  if (memberSearchTextCache.has(member)) return memberSearchTextCache.get(member);
  const value = [
    member.displayName,
    member.customName,
    member.steamNickname,
    member.steamId,
    member.discordId,
    member.discordName,
    member.wechatId,
    member.notes,
    member.squadName,
    member.squad?.name
  ].map((item) => String(item || '').toLowerCase()).join('\n');
  memberSearchTextCache.set(member, value);
  return value;
}

export function memberMatchesSearch(member, query) {
  const normalized = normalizedMemberSearchQuery(query);
  if (!normalized) return true;
  return memberSearchText(member).includes(normalized);
}

export function memberMatchesNormalizedSearch(member, normalizedQuery) {
  if (!normalizedQuery) return true;
  return memberSearchText(member).includes(normalizedQuery);
}
