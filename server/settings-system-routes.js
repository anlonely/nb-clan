import path from 'node:path';
import { promises as fs } from 'node:fs';
import { appendLog } from './audit-logs.js';
import {
  normalizeProxyScope,
  readSettingsRuntimeStore,
  readSettingsPermissionRuntimeStore,
  systemSettings,
  updateSettingsLogStore,
  writeTeamLogoUploadStore
} from './settings-store.js';
import {
  DATA_DIR,
  createId,
  normalizeText,
  nowIso
} from './store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerSettingsSystemRoutes requires ${name}`);
  }
  return value;
}

function requiredFiniteNumber(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`registerSettingsSystemRoutes requires ${name}`);
  }
  return number;
}

export function registerSettingsSystemRoutes(router, {
  requireModuleView,
  requireModuleEdit,
  rootOnly,
  isRootUser,
  publicThirdPartyLoginSettings,
  normalizeThirdPartyLoginSettingsInput,
  validateProxyUrl,
  normalizeTeamLogoUrl,
  systemSettingsPayload,
  decodeImageUpload,
  uploadFilePath,
  teamLogoMaxBytes
} = {}) {
  const requireSystemView = requiredDependency('requireModuleView', requireModuleView)('system');
  const requireSystemEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('system');
  const enforceRootOnly = requiredDependency('rootOnly', rootOnly);
  const checkRoot = requiredDependency('isRootUser', isRootUser);
  const toThirdPartyLoginSettings = requiredDependency('publicThirdPartyLoginSettings', publicThirdPartyLoginSettings);
  const normalizeThirdPartyLogin = requiredDependency('normalizeThirdPartyLoginSettingsInput', normalizeThirdPartyLoginSettingsInput);
  const normalizeProxyUrl = requiredDependency('validateProxyUrl', validateProxyUrl);
  const normalizeLogoUrl = requiredDependency('normalizeTeamLogoUrl', normalizeTeamLogoUrl);
  const toSystemSettings = requiredDependency('systemSettingsPayload', systemSettingsPayload);
  const parseImageUpload = requiredDependency('decodeImageUpload', decodeImageUpload);
  const toUploadFilePath = requiredDependency('uploadFilePath', uploadFilePath);
  const logoMaxBytes = requiredFiniteNumber('teamLogoMaxBytes', teamLogoMaxBytes);

  router.put('/settings/third-party-login', requireSystemEdit, async (req, res, next) => {
    try {
      await updateSettingsLogStore(async (store) => {
        const permissionStore = await readSettingsPermissionRuntimeStore();
        store.settings ||= {};
        const existing = store.settings.thirdPartyLogin || {};
        store.settings.thirdPartyLogin = normalizeThirdPartyLogin(req.body || {}, existing, permissionStore, req.user);
        appendLog(store, req, 'third_party_login_settings_edit', '更新第三方平台登录配置');
      }, 'third_party_login_settings_edit');
      const store = await readSettingsPermissionRuntimeStore();
      sendOk(res, { thirdPartyLogin: toThirdPartyLoginSettings(store, req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/proxy/effective', requireSystemView, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      const store = await readSettingsRuntimeStore();
      sendOk(res, { proxy: (await toSystemSettings(store, { includeSensitive: true })).proxy });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/proxy', requireSystemEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      const proxyUrl = normalizeProxyUrl(req.body?.proxyUrl || '', '代理配置');
      const proxyScope = normalizeProxyScope(req.body?.proxyScope || 'global');
      if (!proxyScope) {
        fail(res, 400, '代理作用范围无效');
        return;
      }
      await updateSettingsLogStore((store) => {
        const settings = systemSettings(store);
        settings.proxy.url = proxyUrl;
        settings.proxy.nodeId = '';
        settings.proxy.scope = proxyScope;
        settings.proxy.updatedAt = proxyUrl ? nowIso() : '';
        appendLog(store, req, 'system_settings_edit', '更新代理配置', {
          metadata: { proxyScope, enabled: Boolean(proxyUrl) }
        });
      }, 'system_proxy_update');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { system: await toSystemSettings(store, { includeSensitive: true, includeStorage: true }) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/system', requireSystemEdit, async (req, res, next) => {
    try {
      const root = checkRoot(req.user);
      const proxyUrl = root ? normalizeProxyUrl(req.body?.proxyUrl || '', '代理配置') : '';
      const proxyScope = root ? normalizeProxyScope(req.body?.proxyScope || 'global') : '';
      if (root && !proxyScope) {
        fail(res, 400, '代理作用范围无效');
        return;
      }
      const teamLogoUrl = normalizeLogoUrl(req.body?.teamLogoUrl || '');
      await updateSettingsLogStore((store) => {
        const settings = systemSettings(store);
        if (root) {
          settings.proxy.url = proxyUrl;
          settings.proxy.nodeId = '';
          settings.proxy.scope = proxyScope;
          settings.proxy.updatedAt = proxyUrl ? nowIso() : '';
        }
        settings.teamLogoUrl = teamLogoUrl;
        settings.teamLogoUpdatedAt = teamLogoUrl ? nowIso() : '';
        appendLog(store, req, 'system_settings_edit', root ? '更新系统配置' : '更新战队徽标');
      }, 'system_settings_update');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { system: await toSystemSettings(store, { includeSensitive: root, includeStorage: true }) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/system/team-logo', requireSystemEdit, async (req, res, next) => {
    try {
      const mimeType = normalizeText(req.body?.mimeType, 80);
      const originalName = normalizeText(req.body?.originalName, 120) || 'team-logo.png';
      const dataUrl = String(req.body?.dataUrl || '');
      const { buffer, ext } = parseImageUpload({
        mimeType,
        dataUrl,
        maxBytes: logoMaxBytes,
        unsupportedError: '战队徽标图片格式不支持',
        sizeError: '战队徽标不能超过 2MB'
      });
      const uploadDir = path.join(DATA_DIR, 'uploads', 'team-logo');
      const fileName = `${createId('upload')}.${ext}`;
      const removedUploads = [];
      const filePath = path.join(uploadDir, fileName);
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(filePath, buffer);
      try {
        const upload = {
          id: createId('upload'),
          ownerType: 'system',
          ownerId: 'team-logo',
          kind: 'team_logo',
          fileName,
          originalName,
          mimeType,
          size: buffer.length,
          url: `/uploads/team-logo/${fileName}`,
          createdBy: req.user.id,
          createdAt: nowIso()
        };
        const logoWrite = await writeTeamLogoUploadStore(req, upload);
        removedUploads.push(...(logoWrite?.removedUploads || []));
      } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
      }
      await Promise.all(removedUploads.map((upload) => {
        const filePath = toUploadFilePath(upload);
        return filePath ? fs.unlink(filePath).catch(() => {}) : Promise.resolve();
      }));
      const store = await readSettingsRuntimeStore();
      sendOk(res, { system: await toSystemSettings(store, { includeSensitive: checkRoot(req.user), includeStorage: true }) });
    } catch (error) {
      next(error);
    }
  });
}
