export const KOOK_LOGIN_ROLES = Object.freeze(['46829059', '70213945']);

export async function verifyKookLoginRoles(store, userId, kookApiRequest) {
  const settings = store.settings?.kook || {};
  const guildId = String(process.env.NB_KOOK_OAUTH_GUILD_ID || settings.guildId || '').trim();
  if (!guildId) throw Object.assign(new Error('kookRoleCheckFailed'), { errorKey: 'kookRoleCheckFailed' });
  let user;
  try {
    user = await kookApiRequest(settings, '/user/view', { query: { user_id: userId, guild_id: guildId } });
  } catch {
    throw Object.assign(new Error('kookRoleCheckFailed'), { errorKey: 'kookRoleCheckFailed' });
  }
  if (String(user?.id || '') !== userId || !Array.isArray(user.roles) || user.bot || Number(user.status) === 10) {
    throw Object.assign(new Error('kookRoleRequired'), { errorKey: 'kookRoleRequired' });
  }
  const roles = new Set(user.roles.map(String));
  const roleIds = KOOK_LOGIN_ROLES.filter((id) => roles.has(id));
  if (!roleIds.length) throw Object.assign(new Error('kookRoleRequired'), { errorKey: 'kookRoleRequired' });
  return { guildId, roleIds, verifiedAt: new Date().toISOString() };
}
