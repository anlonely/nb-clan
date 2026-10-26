import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { acquireProductionLease, validateProductionReady } from '../../server/v2/production/migrations.js';
import { IdentityRepository } from '../../server/v2/identity/repository.js';
import { IdentityService } from '../../server/v2/identity/service.js';
import { PlatformAdminRepository } from '../../server/v2/platform-admin/repository.js';
import { KOOK_LOGIN_ROLES } from '../../server/kook-login-eligibility.js';
const need = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { errorCode: code }); };
export function loginPolicies(repo, env = process.env) {
  const settings = repo.scalar('settings') || {}, platform = new PlatformAdminRepository(repo.db);
  const config = platform.get('config', 'discord'), archive = platform.get('legacy-archive', 'discord');
  const targets = (config.targets || []).filter(t => t.enabled === true);
  const guilds = [...new Set(targets.map(t => t.guildId))];
  need(guilds.length === 1 && /^\d{17,20}$/.test(guilds[0]), 'DISCORD_LOGIN_GUILD_SELECTION_REQUIRED');
  const selected = new Set(targets.map(t => t.id));
  const rules = (archive?.targetRules || []).filter(r => selected.has(r.targetId));
  need(rules.length === selected.size, 'DISCORD_REGISTRATION_ROLES_REQUIRED');
  const roles = [...new Set(rules.flatMap(r => [r.memberRegisterRoleId, ...(r.memberRegisterRoleSquadRules || []).map(x => x.roleId)])
    .filter(Boolean).flatMap(v => String(v).split(/[,\s]+/)).filter(Boolean))];
  need(roles.length > 0 && roles.length <= 100 && roles.every(id => /^\d{17,20}$/.test(id)), 'DISCORD_REGISTRATION_ROLES_REQUIRED');
  const policies = [{ provider: 'discord', enabled: true, guildId: guilds[0], allowedRoleIds: roles, matchMode: 'any', defaultRoleId: 'member' }];
  const kookEnabled = settings.thirdPartyLogin?.kook?.enabled ?? (env.NB_KOOK_OAUTH_ENABLED === '1');
  const kookGuild = String(env.NB_KOOK_OAUTH_GUILD_ID || settings.kook?.guildId || '').trim();
  if (kookEnabled) {
    need(/^[A-Za-z0-9_-]{1,100}$/.test(kookGuild), 'KOOK_LOGIN_GUILD_REQUIRED');
    policies.push({ provider: 'kook', enabled: true, guildId: kookGuild, allowedRoleIds: [...KOOK_LOGIN_ROLES], matchMode: 'any', defaultRoleId: 'member' });
  }
  return policies;
}
export async function configureLogin(config, receiptFile, authorization) {
  need(authorization === 'discord_member_registration_roles', 'LOGIN_POLICY_EXPLICIT_SELECTION_REQUIRED');
  const stat = await fs.lstat(receiptFile);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size < 8192, 'PRIVATE_STOP_RECEIPT_REQUIRED');
  const stopReceipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  const lease = await acquireProductionLease(config, { mode: 'maintenance', stopReceipt });
  let db;
  try {
    await validateProductionReady(config);
    db = new DatabaseSync(config.databaseFile);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    const repo = new IdentityRepository(db), identity = new IdentityService(repo), actor = identity.actorForAccount('user_root');
    const policies = loginPolicies(repo), results = [];
    for (const policy of policies) {
      const old = repo.all('policies').find(p => p.provider === policy.provider);
      const same = old && Object.entries(policy).every(([key, value]) => JSON.stringify(old[key]) === JSON.stringify(value));
      const saved = same ? old : identity.savePolicy(actor, { ...policy, expectedRevision: old?.policyRevision || 0 });
      results.push({ provider: saved.provider, enabled: saved.enabled, roleCount: saved.allowedRoleIds.length, policyRevision: saved.policyRevision, replayed: Boolean(same) });
    }
    return { configured: results, realOAuthLoginVerified: false };
  } finally { db?.close(); await lease.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await configureLogin(JSON.parse(process.argv[2]), process.argv[3], process.argv[4]))); }
  catch (error) { console.error(JSON.stringify({ errorCode: /^[A-Z][A-Z0-9_]+$/.test(error.errorCode || '') ? error.errorCode : 'PRODUCTION_LOGIN_CONFIG_FAILED' })); process.exitCode = 1; }
}
