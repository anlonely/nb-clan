const usableName = (name, steamId) => typeof name === 'string' && name.trim() &&
  name.trim() !== steamId && !/^\d{17}$/.test(name.trim());

export function inviteDisplayName({ name, steamId, members = [], records = [] }) {
  if (usableName(name, steamId)) return name.trim();
  const member = members.find(item => item.steamId === steamId);
  if (usableName(member?.displayName, steamId)) return member.displayName.trim();
  const invitee = records.find(item => (item.inviteeSteamId || item.steamId) === steamId &&
    usableName(item.inviteeName || item.displayName, steamId));
  if (invitee) return (invitee.inviteeName || invitee.displayName).trim();
  return '';
}
