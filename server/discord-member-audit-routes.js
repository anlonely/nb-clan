import { readDiscordMembershipAuditStore } from './member-store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerDiscordMemberAuditRoutes requires ${name}`);
  }
  return value;
}

export function registerDiscordMemberAuditRoutes(router, {
  requireModuleView,
  requireModuleEdit,
  rateLimit,
  discordMembershipAuditPayload,
  runDiscordMembershipAudit
} = {}) {
  const requireAuditView = requiredDependency('requireModuleView', requireModuleView)('departedMembers');
  const requireAuditEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('departedMembers');
  const limit = requiredDependency('rateLimit', rateLimit);
  const buildPayload = requiredDependency('discordMembershipAuditPayload', discordMembershipAuditPayload);
  const runAudit = requiredDependency('runDiscordMembershipAudit', runDiscordMembershipAudit);

  router.get('/discord/member-audit', requireAuditView, async (req, res, next) => {
    try {
      const store = await readDiscordMembershipAuditStore();
      sendOk(res, buildPayload(store, req.user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/discord/member-audit/run', requireAuditEdit, limit({ name: 'discord_member_audit_run', windowMs: 60_000, max: 3 }), async (req, res, next) => {
    try {
      await runAudit(req);
      const store = await readDiscordMembershipAuditStore();
      sendOk(res, buildPayload(store, req.user));
    } catch (error) {
      next(error);
    }
  });
}
