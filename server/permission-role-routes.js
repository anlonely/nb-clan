import { appendLog } from './audit-logs.js';
import {
  BUILTIN_ROLE_IDS,
  normalizePermissionRole,
  normalizePermissionRoleCode,
  roleEditModuleIds
} from './permissions.js';
import { updatePermissionRolesLogStore } from './permission-role-store.js';
import { nowIso } from './store.js';
import { readUsersRuntimeStore } from './user-account-store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerPermissionRoleRoutes requires ${name}`);
  }
  return value;
}

export function registerPermissionRoleRoutes(router, {
  requireRootPermissionAccess,
  publicPermissionModules,
  permissionRolesPayload,
  permissionRolesForStore,
  publicPermissionRole,
  permissionRoleUsage,
  rolePermissionChangeCheck
} = {}) {
  const requireRootPermission = requiredDependency('requireRootPermissionAccess', requireRootPermissionAccess);
  const modulesPayload = requiredDependency('publicPermissionModules', publicPermissionModules);
  const rolesPayload = requiredDependency('permissionRolesPayload', permissionRolesPayload);
  const rolesForStore = requiredDependency('permissionRolesForStore', permissionRolesForStore);
  const publicRole = requiredDependency('publicPermissionRole', publicPermissionRole);
  const roleUsage = requiredDependency('permissionRoleUsage', permissionRoleUsage);
  const checkRolePermissionChange = requiredDependency('rolePermissionChangeCheck', rolePermissionChangeCheck);

  router.get('/permissions', requireRootPermission, async (_req, res, next) => {
    try {
      const store = await readUsersRuntimeStore();
      sendOk(res, {
        modules: modulesPayload(),
        roles: rolesPayload(store)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/permissions/roles', requireRootPermission, async (req, res, next) => {
    try {
      const snapshot = await readUsersRuntimeStore();
      const code = normalizePermissionRoleCode(req.body?.code || '');
      if (!code) {
        sendFail(res, 400, '角色标识只能包含小写字母、数字和下划线，并以字母开头');
        return;
      }
      if (BUILTIN_ROLE_IDS.includes(code) || rolesForStore(snapshot).some((role) => role.code === code)) {
        sendFail(res, 409, '角色已存在');
        return;
      }
      const now = nowIso();
      const role = normalizePermissionRole({ ...req.body, code, createdAt: now, updatedAt: now }, {}, now);
      if (!role) {
        sendFail(res, 400, '角色数据无效');
        return;
      }
      const permissionCheck = checkRolePermissionChange(snapshot, req.user, role.permissions);
      if (!permissionCheck.ok) {
        sendFail(res, 403, permissionCheck.error);
        return;
      }
      await updatePermissionRolesLogStore((store) => {
        store.permissionRoles ||= [];
        if (store.permissionRoles.some((item) => item.code === role.code)) {
          throw Object.assign(new Error('角色已存在'), { status: 409 });
        }
        store.permissionRoles.push(role);
        appendLog(store, req, 'permission_role_add', `创建权限角色 ${role.name}`, {
          targetId: role.code,
          metadata: { modules: roleEditModuleIds(role.code, [role]) }
        });
      }, 'permission_role_add');
      const store = await readUsersRuntimeStore();
      sendOk(res, {
        modules: modulesPayload(),
        roles: rolesPayload(store)
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/permissions/roles/:code', requireRootPermission, async (req, res, next) => {
    try {
      const code = normalizePermissionRoleCode(req.params.code || '');
      if (!code) {
        sendFail(res, 400, '角色不存在');
        return;
      }
      const builtIn = BUILTIN_ROLE_IDS.includes(code);
      const snapshot = await readUsersRuntimeStore();
      const existing = rolesForStore(snapshot).find((role) => role.code === code) || (builtIn ? publicRole(snapshot, { code }) : null);
      if (!existing) {
        sendFail(res, 404, '角色不存在');
        return;
      }
      const now = nowIso();
      const role = normalizePermissionRole({ ...req.body, code, updatedAt: now }, existing, now, { allowBuiltIn: builtIn });
      if (!role) {
        sendFail(res, 400, '角色数据无效');
        return;
      }
      const permissionCheck = checkRolePermissionChange(snapshot, req.user, role.permissions);
      if (!permissionCheck.ok) {
        sendFail(res, 403, permissionCheck.error);
        return;
      }
      await updatePermissionRolesLogStore((store) => {
        const roles = rolesForStore(store);
        const index = roles.findIndex((item) => item.code === code);
        if (index === -1) roles.push(role);
        else roles[index] = role;
        store.permissionRoles = roles;
        appendLog(store, req, 'permission_role_edit', `编辑权限角色 ${role.name}`, {
          targetId: role.code,
          metadata: { modules: roleEditModuleIds(role.code, [role]) }
        });
      }, 'permission_role_edit');
      const store = await readUsersRuntimeStore();
      sendOk(res, {
        modules: modulesPayload(),
        roles: rolesPayload(store)
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/permissions/roles/:code', requireRootPermission, async (req, res, next) => {
    try {
      const code = normalizePermissionRoleCode(req.params.code || '');
      if (!code || BUILTIN_ROLE_IDS.includes(code)) {
        sendFail(res, 400, '内置角色不能删除');
        return;
      }
      const snapshot = await readUsersRuntimeStore();
      if (roleUsage(snapshot, code) > 0) {
        sendFail(res, 409, '该角色仍有账号使用，不能删除');
        return;
      }
      await updatePermissionRolesLogStore((store) => {
        const role = rolesForStore(store).find((item) => item.code === code);
        if (!role) throw Object.assign(new Error('角色不存在'), { status: 404 });
        store.permissionRoles = rolesForStore(store).filter((item) => item.code !== code);
        appendLog(store, req, 'permission_role_delete', `删除权限角色 ${role.name}`, { targetId: role.code });
      }, 'permission_role_delete');
      const store = await readUsersRuntimeStore();
      sendOk(res, {
        modules: modulesPayload(),
        roles: rolesPayload(store)
      });
    } catch (error) {
      next(error);
    }
  });
}
