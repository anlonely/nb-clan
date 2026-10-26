import '../v2-baseline/loopback-only.mjs';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv[2] !== '--isolated-child') {
  const base = path.join(root, 'work/v2-management');
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(path.join(base, 'run-'));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
    cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai',
      NB_DATA_DIR: path.join(run, 'data'), NB_SQLITE_FILE: path.join(run, 'data/nb-clan.sqlite'),
      NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_DISABLE_BACKGROUND_JOBS: '1',
      NB_DISABLE_DATA_BACKUP: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
      NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_ROOT_PASSWORD: randomBytes(32).toString('hex'),
      MANAGEMENT_RUN_DIR: run, MANAGEMENT_BROWSER: process.argv.includes('--browser') ? '1' : '0' } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} else {
  const run = process.env.MANAGEMENT_RUN_DIR;
  assert.equal(path.dirname(run), path.join(root, 'work/v2-management'));
  assert.match(path.basename(run), /^run-[A-Za-z0-9]+$/);
  assert.equal(await realpath(run), run);
  assert.equal(process.env.NB_DATA_DIR, path.join(run, 'data'));
  assert.equal(process.env.NB_SQLITE_FILE, path.join(run, 'data/nb-clan.sqlite'));
  for (const key of ['NB_DISABLE_BACKGROUND_JOBS', 'NB_DISABLE_DATA_BACKUP', 'NB_DISABLE_EXTERNAL_VITAL', 'NB_DISABLE_EXTERNAL_ATLAS', 'NB_V2_IDENTITY_ENABLED']) assert.equal(process.env[key], '1');
  assert.equal(process.env.NB_STORAGE_MODE, 'sqlite-primary');
  await assert.rejects(access(process.env.NB_SQLITE_FILE), { code: 'ENOENT' });
  const { createServer } = await import('node:http');
  const { default: express } = await import('express');
  const store = await import('../../../server/store.js');
  const storage = await import('../../../server/storage/sqlite.js');
  const { installIdentitySchema, IdentityRepository } = await import('../../../server/v2/identity/repository.js');
  const { applyIdentityMigration, planIdentityMigration } = await import('../../../server/v2/identity/migration.js');
  const { installSchedulingSchema, SchedulingRepository } = await import('../../../server/v2/scheduling/repository.js');
  const { applySchedulingMigration, planSchedulingMigration } = await import('../../../server/v2/scheduling/migration.js');
  const { installMemberAdminSchema } = await import('../../../server/v2/member-admin/repository.js');
  const { installStatsSchema } = await import('../../../server/v2/stats/repository.js');
  const { installSyncCenterSchema } = await import('../../../server/v2/sync-center/repository.js');
  const { installRealtimeSchema } = await import('../../../server/v2/realtime/repository.js');
  const { installPlatformAdminSchema } = await import('../../../server/v2/platform-admin/repository.js');
  const { migrateSystemAdmin } = await import('../../../server/v2/system-admin/repository.js');
  const { createLocalSystemStorage } = await import('../../../server/v2/system-admin/storage.js');
  const { seedIdentities } = await import('../v2-member-space/fixtures.mjs');
  const { createManagementRuntime } = await import('../../../server/v2/management-runtime/index.js');
  const { installSourceWindowSchema } = await import('../../../server/v2/management-adapters/source-window/index.js');
  const { installSourceAdapterSchema } = await import('../../../server/v2/management-adapters/sources/index.js');
  const { installMemberInboxSchema } = await import('../../../server/v2/member-inbox/index.js');
  const { installPlatformMediaSchema } = await import('../../../server/v2/platform-media/index.js');
  const { installPlatformAdminExtrasSchema } = await import('../../../server/v2/platform-admin-extras/index.js');
  const { installMemberFollowupsSchema } = await import('../../../server/v2/member-followups/index.js');
  const { installRelayAdminSchema } = await import('../../../server/v2/relay-admin/index.js');
  const { installSourceAdminSchema } = await import('../../../server/v2/source-admin/index.js');
  const extrasCatalog = [{ id: 'isolated', serverProfileId: 'isolated-server', vitalServerId: '12', name: '隔离服务器' }];
  const { installNotificationSchema } = await import('../../../server/v2/notifications/index.js');
  const { createNotificationRuntime } = await import('../../../server/v2/notification-runtime/index.js');
  const { createIsolatedNotificationTransport } = await import('../../../server/v2/notification-platforms/isolated-transport.js');
  const { createDiscordVerifier, createKookVerifier } = await import('../../../server/v2/notification-platforms/verifiers.js');
  const { pngFixture } = await import('../v2-system-admin/image-fixture.mjs');
  await store.ensureStore();
  const db = await storage.openSqliteDatabase(), legacy = await store.readStore();
  assert.equal(legacy.members.length, 0);
  installIdentitySchema(db); const repo = new IdentityRepository(db);
  applyIdentityMigration(repo, planIdentityMigration(legacy)); seedIdentities(repo);
  // Explicit local platform evidence: no provider request or external qualification claim.
  const eligibilityNow = Date.now();
  for (const mapping of repo.all('identities').filter(row => ['discord', 'kook'].includes(row.provider))) {
    const policy = repo.all('policies').find(row => row.provider === mapping.provider);
    assert.ok(policy?.enabled);
    repo.put('eligibility', { id: `isolated-evidence-${mapping.id}`, provider: mapping.provider,
      externalId: mapping.externalId, policyId: policy.id, policyRevision: policy.policyRevision,
      guildId: policy.guildId, status: 'eligible', checkedAt: new Date(eligibilityNow).toISOString(),
      expiresAt: new Date(eligibilityNow + 3600000).toISOString(), source: 'controlled_local_fixture' });
  }

  repo.put('identities', { id: 'isolated-mini-alpha', provider: 'wechat:isolated_app',
    externalId: 'isolated_openid_alpha', accountId: 'g05_account_alpha', revision: 1 });
  const rootAccount = repo.all('accounts').find(account => account.legacyUserId && repo.get('users', account.legacyUserId)?.username === 'root');
  assert.ok(rootAccount);
  repo.put('identities', { id: 'isolated-mini-root', provider: 'wechat:isolated_app',
    externalId: 'isolated_openid_root', accountId: rootAccount.id, revision: 1 });
  repo.put('wechatUsers', { id: 'isolated_wx_alpha', appId: 'isolated_app', openid: 'isolated_openid_alpha',
    accountId: 'g05_account_alpha', memberId: 'g05_alpha', status: 'approved', revision: 1, subscriptionPreferences: {} });
  installSchedulingSchema(db); applySchedulingMigration(new SchedulingRepository(db), planSchedulingMigration({}));
  installMemberAdminSchema(db); installStatsSchema(db); installSyncCenterSchema(db);
  installRealtimeSchema(db);
  installPlatformAdminSchema(db);
  db.exec('CREATE TABLE isolated_main_vault(platform TEXT, field TEXT, value TEXT, PRIMARY KEY(platform,field))');
  installSourceAdapterSchema(db);
  installSourceWindowSchema(db);
  installMemberInboxSchema(db);
  installPlatformMediaSchema(db);
  installPlatformAdminExtrasSchema(db, { catalog: extrasCatalog });
  installSourceAdminSchema(db, { apply: true });
  installRelayAdminSchema(db, {apply:true});
  installMemberFollowupsSchema(db);
  installNotificationSchema(db);
  (await import('../../../server/v2/notifications/repository.js')).installNotificationBusinessSchema(db);
  migrateSystemAdmin(db, { apply: true });
  const managedDirectory = path.join(run, 'managed');
  await mkdir(managedDirectory);
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.NB_V2_PUBLIC_ORIGIN = origin;
  const { createApiRouter, stopBackgroundJobs } = await import('../../../server/api.js');
  const pair = generateKeyPairSync('ed25519');
  const notificationTransport = createIsolatedNotificationTransport();
  const shareCodeGenerations = [], communityProofs = new Map();
  const notificationTarget = { id: 'isolated-discord', platform: 'discord', guildId: '400000000000000002', channelId: '400000000000000003',
    label: '隔离频道', enabled: true, configurationRevision: 1, languages: ['zh-CN'], roleOptions: [],
    capabilities: { preview: true, send: true, mentionRoles: false, mentionEveryone: false }, runtimeMode: 'isolated', transportKey: 'isolated-main-discord' };
  const kookVerifyToken = randomBytes(32).toString('hex');
  const kookTarget = { ...notificationTarget, id: 'isolated-kook', platform: 'kook', channelId: '400000000000000004', transportKey: 'isolated-main-kook' };
  const notificationTargets = [notificationTarget, kookTarget];
  const api = createApiRouter({
    notificationRuntimeFactory: deps => createNotificationRuntime({ ...deps, publicOrigin: origin, intervalMs: 60000,
      catalog: { listTargets: () => structuredClone(notificationTargets),
        getTarget: id => structuredClone(notificationTargets.find(target => target.id === id) || null),
        listOptions: () => ({ items: [], nextCursor: null }) },
      transport: notificationTransport, verifiers: {
        discord: createDiscordVerifier({ publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), applicationId: '400000000000000001' }),
        kook: createKookVerifier({ verifyToken: kookVerifyToken })
      } }),
    managementRuntimeFactory: deps => createManagementRuntime({ ...deps, intervalMs: 60000,
    platformAdapters: identity => ({ vault: { writeSync: ({ db: vaultDb, platform, values }) => {
      assert.equal(vaultDb, identity.repo.db); assert.equal(vaultDb.isTransaction, true);
      for (const [field, value] of Object.entries(values)) vaultDb.prepare('INSERT OR REPLACE INTO isolated_main_vault VALUES(?,?,?)').run(platform, field, value);
    } } }),
    sourceAdminOptions: () => ({}),
    relayAdminOptions: () => ({}),
    memberFollowupOptions: () => ({readPolicy: () => ({enabled:false,revision:'isolated-disabled',tasks:{}}),
      readPrincipal: () => ({accountId:rootAccount.id,permissionVersion:identity.actorForAccount(rootAccount.id).permissionVersion})}),
    sourceHostOptions: () => ({ fetchImpl: fetch, capabilities: {} }),
    memberInboxOptions: () => ({ appId: 'isolated_app', readConfig: () => ({ appId: 'isolated_app',
      enabled: true, revision: 1, subscriptionTemplates: { wipeOpen: 'isolated_template' } }) }),
    platformMediaOptions: () => ({ appId: 'isolated_app',
      getAccessToken: async ({ appId, generation, assertCurrent }) => { assertCurrent();
        shareCodeGenerations.push(generation); return { appId, generation, accessToken: 'isolated-share-token' }; },
      exchangeCode: async ({ accessToken, scene, assertCurrent }) => { assertCurrent();
        assert.equal(accessToken, 'isolated-share-token'); assert.equal(scene, 'm=kda');
        return new Response(pngFixture(16, 16), { headers: { 'Content-Type': 'image/png' } }); }
    }),
    adminExtrasOptions: () => ({ readCatalog: () => extrasCatalog }),
    // Explicit host, with unavailable external credentials in this isolated run.
    platformHostOptions: identity => ({
      community: Object.fromEntries(['discord', 'kook'].map(platform => [platform, { verify: async envelope => communityProofs.get(envelope.ticket) }])),
      g06: { platforms: api.v2Runtime.notifications.getSystem(identity).service.platforms,
        targets: () => structuredClone(notificationTargets) },
      forwarding: { source: { read: async ({ platform, channelId }) => {
        assert.equal(platform, 'discord'); assert.equal(channelId, notificationTarget.channelId);
        return { verified: true, items: [{ id: 'isolated-forward-source-1', channelId,
          content: '隔离转发消息', author: '隔离成员' }], nextCursor: 'isolated-forward-cursor' };
      } } }, wechat: { appId: 'isolated_app', evidenceLevel: 'isolated',
      readConfig: () => ({ enabled: true, appId: 'isolated_app', minClientVersion: 1 }),
      exchangeCode: async ({ code, appId }) => {
        if (code === 'isolated-root-code') return { verified: true, appId, openid: 'isolated_openid_root' };
        assert.ok(['isolated-single-use-code', 'isolated-alpha-after-config'].includes(code));
        return { verified: true, appId, openid: 'isolated_openid_alpha' };
      } } }),
    memberOptions: () => ({}),
    systemOptions: identity => ({ storage: createLocalSystemStorage({ db: identity.repo.db,
      databaseFile: process.env.NB_SQLITE_FILE, directory: managedDirectory }) }),
    realtimeOptions: () => ({ authorizeLegacyAction: () => true }) // Explicit isolated authority fixture.
  }) });
  app.use('/api', api);
  const checks = [];
  try {
    const identity = await api.v2Runtime.getIdentity();
    const initialManagement = api.v2Runtime.management.getSystem(identity);
    await initialManagement.platforms.service.save(identity.actorForAccount(rootAccount.id), 'wechat', {
      expectedRevision: 0, config: { enabled: true, appId: 'isolated_app', minClientVersion: 1,
        subscriptionTemplates: { wipeOpen: 'isolated_template' } }
    }, { operationId: 'isolated-canonical-wechat-setup' });
    await api.v2Runtime.start();
    for (const route of ['/wechat-onboarding/exchange', '/wechat-onboarding/applications', '/member-admin/reviews/old-id']) {
      const retired = await fetch(origin + '/api/v2' + route, { method: 'POST' });
      assert.equal(retired.status, 410);
    }
    checks.push({ retiredApplicationRoutes: true });
    api.v2Runtime.management.getSystem(identity).inbox.repo.put('wechatNotifications', { id: 'isolated_notice', wechatUserId: 'isolated_wx_alpha', appId: 'isolated_app',
      title: '隔离通知', body: '本地验证', revision: 1, createdAt: new Date().toISOString() });
    const miniLogin = await fetch(`${origin}/api/v2/mini-program/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'isolated-single-use-code' }) });
    assert.equal(miniLogin.status, 200);
    const miniLoginData = (await miniLogin.json()).data;
    const miniToken = miniLoginData.token;
    const readShareCode = async token => {
      const response = await fetch(`${origin}/api/v2/platform-media/share-code?metric=kda`, {
        headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/png/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngFixture(16, 16));
    };
    await readShareCode(miniToken); await readShareCode(miniToken);
    assert.deepEqual(shareCodeGenerations, [1]);
    for (const id of ['notification_settings', 'notification_settings_save', 'notifications', 'notification_read']) {
      const capability = miniLoginData.capabilities.commands.find(command => command.id === id);
      assert.equal(capability.available, true); assert.equal(capability.reasonCode, null);
    }
    const miniMe = () => fetch(`${origin}/api/v2/mini-program/commands/me`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miniToken}`, 'Idempotency-Key': randomUUID() }, body: '{}' });
    const miniProfile = await miniMe();
    assert.equal(miniProfile.status, 200);
    assert.equal((await miniProfile.json()).data.profile.id, 'g05_alpha');
    const miniCommand = async (command, body) => {
      const response = await fetch(`${origin}/api/v2/mini-program/commands/${command}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miniToken}`, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
    };
    const inboxSettings = await miniCommand('notification_settings', {});
    const avatarBytes = pngFixture(16, 16);
    const avatarUpload = await fetch(`${origin}/api/v2/platform-media/avatar`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miniToken}`, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${avatarBytes.toString('base64')}`,
        sha256: createHash('sha256').update(avatarBytes).digest('hex'), expectedRevision: 0 }) });
    const avatarResult = await avatarUpload.json();
    assert.equal(avatarUpload.status, 200, JSON.stringify(avatarResult));
    const avatarRead = await fetch(`${origin}/api/v2/platform-media/avatar-image`, { headers: { Authorization: `Bearer ${miniToken}` } });
    assert.equal(avatarRead.status, 200);
    assert.deepEqual(Buffer.from(await avatarRead.arrayBuffer()), avatarBytes);
    const legacyAvatar = await fetch(`${origin}/api/wechat/avatar-image`, { headers: { 'x-nb-wechat-session': miniToken } });
    assert.equal(legacyAvatar.status, 200);
    assert.deepEqual(Buffer.from(await legacyAvatar.arrayBuffer()), avatarBytes);
    await miniCommand('notification_settings_save', { expectedRevision: inboxSettings.preferencesRevision,
      expectedConfigRevision: inboxSettings.configRevision, subscriptions: { wipeOpen: 'accept' } });
    const inboxList = await miniCommand('notifications', {});
    assert.equal(inboxList.notifications[0].id, 'isolated_notice');
    await miniCommand('notification_read', { notificationId: 'isolated_notice', expectedRevision: 1 });
    assert.ok(api.v2Runtime.management.getSystem(identity).inbox.repo.get('wechatNotifications', 'isolated_notice').readAt);
    const inboxBrowserSession = identity.issueSession(repo.get('accounts', 'g05_account_alpha'));
    const inboxWeb = await fetch(`${origin}/api/v2/member-inbox/settings`, {
      headers: { Cookie: `nb_v2_session=${inboxBrowserSession.token}` } });
    const inboxWebBody = await inboxWeb.json();
    assert.equal(inboxWeb.status, 200, JSON.stringify(inboxWebBody));
    assert.equal(inboxWebBody.data.configRevision, inboxSettings.configRevision);
    assert.equal((await fetch(`${origin}/api/v2/member-inbox/settings`, { method: 'PUT',
      headers: { Cookie: `nb_v2_session=${inboxBrowserSession.token}`, 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status, 403);
    const miniLogout = await fetch(`${origin}/api/v2/mini-program/logout`, { method: 'POST',
      headers: { Authorization: `Bearer ${miniToken}` } });
    assert.equal(miniLogout.status, 200);
    assert.equal((await miniMe()).status, 401);
    assert.equal((await fetch(`${origin}/api/wechat/__unmapped`)).status, 410);
    assert.equal((await fetch(`${origin}/api/v2/mini-program/__unmapped`)).status, 404);
    for (const [method, path] of [['PUT', '/settings/discord'], ['PUT', '/settings/kook'],
      ['GET', '/settings/discord-kook-bridge'], ['POST', '/settings/discord-kook-bridge/sync'],
      ['POST', '/settings/discord/member-ranking-card']]) {
      const retired = await fetch(`${origin}/api${path}`, { method });
      assert.equal(retired.status, 410);
      assert.equal((await retired.json()).error.errorCode, 'LEGACY_PLATFORM_SETTINGS_RETIRED');
    }
    assert.equal(api.v2Runtime.management.getSystem(identity).platformHost.service,
      api.v2Runtime.management.getSystem(identity).platforms.service);
    const passwordLogin = await fetch(`${origin}/api/v2/auth/password`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: process.env.NB_ROOT_PASSWORD }) });
    assert.equal(passwordLogin.status, 200, 'Atomic password proof login');
    const rootLoginBody = await passwordLogin.json();
    const rootCookie = passwordLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rejectedLogin = await fetch(`${origin}/api/v2/auth/password`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'incorrect-isolated-password' }) });
    assert.equal(rejectedLogin.status, 401, 'Password adapter retains identity error protocol');
    checks.push({ route: '/auth/password', atomicProofLogin: true });
    const session = identity.issueSession(repo.get('accounts', 'g05_account_admin'));
    const headers = { Cookie: `nb_v2_session=${session.token}` };
    const configCommand = { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': 'isolated-wechat-config' },
      body: JSON.stringify({ expectedRevision: 1, config: { enabled: true, appId: 'isolated_app', minClientVersion: 1 } }) };
    const configResponse = await fetch(`${origin}/api/v2/platform-admin/wechat/config`, configCommand);
    const configResult = await configResponse.json();
    assert.equal(configResponse.status, 200, JSON.stringify(configResult));
    assert.equal(configResult.data.revision, 2);
    const configReplay = await fetch(`${origin}/api/v2/platform-admin/wechat/config`, configCommand);
    assert.equal(configReplay.status, 200);
    assert.equal((await configReplay.json()).data.revision, 2);
    assert.equal((await fetch(`${origin}/api/v2/wechat-onboarding/applications`, {
      headers: { Authorization: `Bearer ${applicationBearer}` } })).status, 401);
    const rotatedAlphaResponse = await fetch(`${origin}/api/v2/mini-program/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'isolated-alpha-after-config' }) });
    assert.equal(rotatedAlphaResponse.status, 200);
    const rotatedAlphaToken = (await rotatedAlphaResponse.json()).data.token;
    await readShareCode(rotatedAlphaToken); assert.deepEqual(shareCodeGenerations, [1, 2]);
    checks.push({ route: '/platform-media/share-code', exactPngBytes: true, sameGenerationCached: true,
      canonicalConfigRotationCreatesNewTokenGeneration: true, externalProvider: 'constructed isolated response' });
    const rootMiniResponse = await fetch(`${origin}/api/v2/mini-program/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'isolated-root-code' }) });
    assert.equal(rootMiniResponse.status, 200);
    const rootMiniToken = (await rootMiniResponse.json()).data.token;
    const rootMiniCommand = async (name, body, operationId = randomUUID()) => {
      const response = await fetch(`${origin}/api/v2/mini-program/commands/${name}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootMiniToken}`, 'Idempotency-Key': operationId },
        body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
    };
    const wipeClock = Date.now(), wipeTime = offset => new Date(wipeClock + offset).toISOString();
    const populatedWipe = (await rootMiniCommand('wipe_create', {
      title: '隔离联合档期', description: '本地验证', serverProfileId: 'isolated-server', serverSnapshot: { name: '创建时服务器' },
      timeZone: 'Asia/Shanghai', musterAt: wipeTime(7200000), serverScheduledWipeAt: wipeTime(3600000),
      signupOpensAt: wipeTime(-60000), signupClosesAt: wipeTime(10800000), autoStart: false,
      audience: { squadIds: ['g05_squad'], memberIds: [], includeUnassigned: false }
    })).current;
    const adminSummary = await rootMiniCommand('summary', { wipeId: populatedWipe.id });
    assert.equal(adminSummary.wipeId, populatedWipe.id);
    const serverSaveRequest = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootMiniToken}`,
      'Idempotency-Key': 'isolated-server-save' }, body: JSON.stringify({ serverId: 'isolated', expectedRevision: 0, notes: '隔离更新' }) };
    const serverSave = await fetch(`${origin}/api/v2/mini-program/commands/server_save`, serverSaveRequest);
    const serverSaveBody = await serverSave.json();
    assert.equal(serverSave.status, 200, JSON.stringify(serverSaveBody));
    assert.equal(serverSaveBody.data.current.notes, '隔离更新');
    const serverSaveReplay = await fetch(`${origin}/api/v2/mini-program/commands/server_save`, serverSaveRequest);
    assert.equal(serverSaveReplay.status, 200);
    assert.equal((await serverSaveReplay.json()).data.replayed, true);
    assert.deepEqual(repo.get('schedulingWipes', populatedWipe.id).serverSnapshot, populatedWipe.serverSnapshot);
    const publishedWipe = (await rootMiniCommand('wipe_publish', { wipeId: populatedWipe.id, expectedRevision: populatedWipe.revision })).current;
    const notificationRequest = async (path, body, expectedStatus) => {
      const response = await fetch(`${origin}/api/v2${path}`, { method: 'POST', headers: { Cookie: rootCookie,
        'X-CSRF-Token': rootLoginBody.data.csrfToken, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(result)); return result.data.current;
    };
    const notificationPreview = await notificationRequest(`/wipes/${publishedWipe.id}/notification-previews`, {
      expectedContentRevision: publishedWipe.contentRevision, templateId: 'wipe-notification', templateRevision: 1,
      purpose: 'signup_open', purposeInstance: 'primary', repeatOfIntentId: null, reason: null, duplicateRiskAcknowledged: false,
      targets: [{ targetId: notificationTarget.id, language: 'zh-CN', mentionMode: 'none', roleIds: [] }],
      audience: publishedWipe.audience, schedule: null
    }, 201);
    const storedPreview = api.v2Runtime.notifications.getSystem(identity).service.repo.get('previews', notificationPreview.id);
    assert.equal(storedPreview.targets[0].snapshot.counts.eligibleTotal, 4);
    assert.equal(storedPreview.targets[0].snapshot.counts.unanswered, 4);
    checks.push({ route: '/wipes/:id/notification-previews', eligibleTotal: 4, unanswered: 4,
      qualification: 'explicit isolated evidence, no external platform request' });
    const notificationIntent = await notificationRequest(`/wipes/${publishedWipe.id}/publish-intents`, {
      previewId: notificationPreview.id, contentHash: notificationPreview.contentHash, expectedContentRevision: notificationPreview.contentRevision,
      purpose: notificationPreview.purpose, purposeInstance: notificationPreview.purposeInstance
    }, 202);
    await api.v2Runtime.notifications.getSystem(identity).worker.runOnce({ workerId: 'isolated-main-check', limit: 10 });
    const populatedDelivery = api.v2Runtime.notifications.getSystem(identity).service.repo.get('deliveries', notificationIntent.deliveryIds[0]);
    assert.equal(populatedDelivery.status, 'sent', JSON.stringify(populatedDelivery));
    const initialCard = notificationTransport.inspect().messages[0];
    const delegatedSignup = { method: 'PUT', headers: { Cookie: rootCookie,
      'X-CSRF-Token': rootLoginBody.data.csrfToken, Origin: origin, 'Content-Type': 'application/json',
      'Idempotency-Key': 'isolated-populated-signup' }, body: JSON.stringify({ response: 'attending_on_time',
      expectedSignupRevision: 0, confirmedContentRevision: publishedWipe.contentRevision,
      expectedArrivalAt: null, timeZone: 'Asia/Shanghai', reason: '隔离主流程本人委托' }) };
    const signupPath = `${origin}/api/v2/wipes/${publishedWipe.id}/signups/g05_alpha`;
    const signupResponse = await fetch(signupPath, delegatedSignup);
    const signupBody = await signupResponse.json();
    assert.equal(signupResponse.status, 200, JSON.stringify(signupBody));
    const signupReplay = await fetch(signupPath, delegatedSignup);
    assert.equal(signupReplay.status, 200);
    assert.equal((await signupReplay.json()).data.replayed, true);
    const notificationSystem = api.v2Runtime.notifications.getSystem(identity);
    await notificationSystem.worker.runOnce({ workerId: 'isolated-main-edit', limit: 100 });
    const updatedCards = notificationTransport.inspect().messages;
    assert.equal(updatedCards.length, 1);
    assert.equal(updatedCards[0].messageId, initialCard.messageId);
    assert.ok(updatedCards[0].editCount >= 1);
    assert.notDeepEqual(updatedCards[0].payload, initialCard.payload);
    assert.equal(notificationTransport.getCalls().filter(call => call.operation === 'send').length, 1);
    const signupCounts = notificationSystem.service.scheduling.summary(identity.actorForAccount(rootAccount.id), publishedWipe.id).counts;
    assert.equal(signupCounts.eligibleTotal, 4); assert.equal(signupCounts.onTime, 1); assert.equal(signupCounts.unanswered, 3);
    checks.push({ route: '/wipes/:id/signups/:memberId', actualDelegatedWrite: true, idempotentReplay: true,
      canonicalCounts: signupCounts, existingCardEdited: true, sendCount: 1, transport: 'isolated native protocol' });

    const callbackAction = updatedCards[0].payload.components.flatMap(row => row.components)
      .map(button => button.custom_id).filter(Boolean).find(token => notificationSystem.references.resolve(token,
        { platform: 'discord', guildId: notificationTarget.guildId, channelId: notificationTarget.channelId }).action === 'attending_on_time');
    assert.ok(callbackAction);
    const priorDiscordProvider = identity.providers.discord;
    let isolatedRoleReads = 0;
    identity.providers.discord = { roles: async (externalId, guildId) => {
      assert.equal(externalId, 'discord_g05_beta'); assert.equal(guildId, 'g05_fixture_guild'); isolatedRoleReads++;
      return { externalId, guildId, roleIds: ['g05_fixture_role'] };
    } };
    try {
      const callbackRaw = Buffer.from(JSON.stringify({ id: 'isolated-main-callback-1', application_id: '400000000000000001',
        type: 3, guild_id: notificationTarget.guildId, channel_id: notificationTarget.channelId,
        member: { user: { id: 'discord_g05_beta' } }, token: 'isolated-private-callback-token',
        data: { component_type: 2, custom_id: callbackAction } }));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const callbackHeaders = { 'Content-Type': 'application/json', 'x-signature-timestamp': timestamp,
        'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), callbackRaw]), pair.privateKey).toString('hex') };
      const postCallback = async () => {
        const response = await fetch(`${origin}/api/integrations/v2/notifications/discord`, {
          method: 'POST', headers: callbackHeaders, body: callbackRaw });
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
        for (let i = 0; api.v2Runtime.notifications.diagnostics().callbackJobs && i < 100; i++)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(api.v2Runtime.notifications.diagnostics().callbackJobs, 0);
      };
      const tamperedCallback = await fetch(`${origin}/api/integrations/v2/notifications/discord`, {
        method: 'POST', headers: callbackHeaders, body: Buffer.concat([callbackRaw, Buffer.from(' ')]) });
      assert.equal(tamperedCallback.status, 401);
      assert.equal(notificationSystem.service.scheduling.signup(publishedWipe, 'g05_beta').signupRevision, 0);
      assert.equal(isolatedRoleReads, 0);
      await postCallback(); await postCallback();
      const betaSignup = notificationSystem.service.scheduling.signup(publishedWipe, 'g05_beta');
      assert.equal(betaSignup.response, 'attending_on_time'); assert.equal(betaSignup.signupRevision, 1);
      assert.ok(isolatedRoleReads >= 1);
      await notificationSystem.worker.runOnce({ workerId: 'isolated-callback-edit', limit: 100 });
      assert.equal(notificationTransport.getCalls().filter(call => call.operation === 'send').length, 1);
      assert.equal(notificationTransport.inspect().messages[0].messageId, initialCard.messageId);
      assert.ok(notificationTransport.inspect().messages[0].editCount >= 2);
      checks.push({ route: '/integrations/v2/notifications/discord', verifiedEd25519RawBody: true, tamperedBodyRejectedBeforeEligibility: true,
        noCookieRequired: true, replaySignupRevision: 1, existingCardUpdated: true, qualification: 'explicit isolated provider' });
    } finally { identity.providers.discord = priorDiscordProvider; }
    const kookPreview = await notificationRequest(`/wipes/${publishedWipe.id}/notification-previews`, {
      expectedContentRevision: publishedWipe.contentRevision, templateId: 'wipe-notification', templateRevision: 1,
      purpose: 'signup_open', purposeInstance: 'primary', repeatOfIntentId: null, reason: null, duplicateRiskAcknowledged: false,
      targets: [{ targetId: kookTarget.id, language: 'zh-CN', mentionMode: 'none', roleIds: [] }],
      audience: publishedWipe.audience, schedule: null
    }, 201);
    await notificationRequest(`/wipes/${publishedWipe.id}/publish-intents`, {
      previewId: kookPreview.id, contentHash: kookPreview.contentHash, expectedContentRevision: kookPreview.contentRevision,
      purpose: kookPreview.purpose, purposeInstance: kookPreview.purposeInstance
    }, 202);
    await notificationSystem.worker.runOnce({ workerId: 'isolated-kook-send', limit: 100 });
    const kookCard = notificationTransport.getMessages().find(message => message.platform === 'kook');
    assert.ok(kookCard);
    const kookAction = JSON.parse(kookCard.payload.content).flatMap(card => card.modules)
      .filter(module => module.type === 'action-group').flatMap(module => module.elements)
      .filter(button => button.click === 'return-val').map(button => button.value)
      .find(token => notificationSystem.references.resolve(token, { platform: 'kook', guildId: null,
        channelId: kookTarget.channelId }).action === 'attending_on_time');
    assert.ok(kookAction);
    const priorKookProvider = identity.providers.kook;
    identity.providers.kook = { roles: async (externalId, guildId) => {
      assert.equal(externalId, 'kook_g05_leader'); assert.equal(guildId, 'g05_fixture_guild');
      return { externalId, guildId, roleIds: ['g05_fixture_role'] };
    } };
    try {
      const kookEnvelope = { s: 0, sn: 1, d: { type: 255, channel_type: 'PERSON', msg_id: 'isolated-kook-callback-1',
        msg_timestamp: Date.now(), verify_token: kookVerifyToken, target_id: 'isolated-person',
        extra: { type: 'message_btn_click', body: { user_id: 'kook_g05_leader', value: kookAction,
          target_id: kookTarget.channelId, msg_id: kookCard.messageId } } } };
      const postKook = async envelope => {
        const response = await fetch(`${origin}/api/integrations/v2/notifications/kook`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' },
          body: deflateSync(Buffer.from(JSON.stringify(envelope))) });
        await response.arrayBuffer();
        for (let i = 0; api.v2Runtime.notifications.diagnostics().callbackJobs && i < 100; i++)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(api.v2Runtime.notifications.diagnostics().callbackJobs, 0); return response.status;
      };
      const invalidKook = structuredClone(kookEnvelope); invalidKook.d.verify_token = 'invalid-isolated-token';
      assert.equal(await postKook(invalidKook), 401);
      assert.equal(notificationSystem.service.scheduling.signup(publishedWipe, 'g05_leader').signupRevision, 0);
      assert.equal(await postKook(kookEnvelope), 200); assert.equal(await postKook(kookEnvelope), 200);
      const leaderSignup = notificationSystem.service.scheduling.signup(publishedWipe, 'g05_leader');
      assert.equal(leaderSignup.response, 'attending_on_time'); assert.equal(leaderSignup.signupRevision, 1);
      await notificationSystem.worker.runOnce({ workerId: 'isolated-kook-edit', limit: 100 });
      assert.equal(notificationTransport.getCalls().filter(call => call.operation === 'send' && call.platform === 'kook').length, 1);
      const updatedKook = notificationTransport.getMessages().find(message => message.platform === 'kook');
      assert.equal(updatedKook.messageId, kookCard.messageId); assert.ok(updatedKook.editCount >= 1);
      checks.push({ route: '/integrations/v2/notifications/kook', compressedNativeEnvelope: true,
        invalidTokenRejected: true, replaySignupRevision: 1, existingCardUpdated: true, transport: 'isolated' });
    } finally { identity.providers.kook = priorKookProvider; }
    const platformPost = async (path, body, operationId) => {
      const response = await fetch(`${origin}/api/v2/platform-admin/${path}`, { method: 'POST', headers: {
        Cookie: rootCookie, 'X-CSRF-Token': rootLoginBody.data.csrfToken, Origin: origin,
        'Content-Type': 'application/json', 'Idempotency-Key': operationId }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
    };
    await platformPost('bridge/config', { expectedRevision: 0, config: { enabled: true, routes: [{
      id: 'isolated-route', name: '隔离转发', enabled: true, discordGuildId: notificationTarget.guildId,
      discordChannelId: notificationTarget.channelId, kookGuildId: kookTarget.guildId, kookChannelId: kookTarget.channelId,
      direction: 'discord_to_kook', translate: false, languages: [], includeAttachments: false
    }] } }, 'isolated-bridge-save');
    notificationTransport.enqueue({ kind: 'response_lost', operation: 'send', platform: 'kook' });
    const beforeForwardSends = notificationTransport.getCalls().filter(call => call.operation === 'send').length;
    const forwardRun = await platformPost('bridge/actions/forward_run', { expectedRevision: 1 }, 'isolated-forward-run');
    assert.equal(forwardRun.result.counts.unknown, 1, JSON.stringify(forwardRun));
    const forwardRepo = api.v2Runtime.management.getSystem(identity).platforms.service.repo;
    const rawForward = forwardRepo.db.prepare("SELECT id,payload FROM platform_admin_records WHERE kind='forward'").get();
    assert.ok(rawForward); assert.equal(JSON.parse(rawForward.payload).status, 'unknown');
    const reconciled = await platformPost('bridge/actions/forward_reconcile', {
      expectedRevision: 1, recordId: rawForward.id }, 'isolated-forward-reconcile');
    assert.equal(reconciled.result.state, 'unknown', JSON.stringify(reconciled));
    await platformPost('bridge/actions/forward_reconcile', { expectedRevision: 1, recordId: rawForward.id }, 'isolated-forward-reconcile');
    await platformPost('bridge/actions/forward_run', { expectedRevision: 1 }, 'isolated-forward-run-again');
    assert.equal(notificationTransport.getCalls().filter(call => call.operation === 'send').length, beforeForwardSends + 1);
    assert.equal(forwardRepo.get('forward', rawForward.id).status, 'unknown');
    checks.push({ route: '/platform-admin/bridge/actions/forward_reconcile', actualResponseLostAfterSend: true,
      unknownPreserved: true, explicitReconcileReplay: true, repeatedRunDoesNotResend: true, transport: 'isolated native KOOK' });
    for (const target of notificationTargets) {
      const platform = target.platform;
      await platformPost(`${platform}/config`, { expectedRevision: 0, config: { enabled: true,
        targets: [{ id: target.id, name: '隔离社区入口', enabled: true, guildId: target.guildId,
          channelId: target.channelId, enabledCommandIds: ['map'] }] } }, `isolated-community-config-${platform}`);
      const ticket = `isolated-community-${platform}`;
      communityProofs.set(ticket, { provider: platform, verified: true, externalId: `${platform}_g05_alpha`,
        interactionId: `isolated-community-map-${platform}`, guildId: target.guildId, channelId: target.channelId,
        payload: { command: 'map', wipeId: publishedWipe.id } });
      const originalProvider = identity.providers[platform];
      identity.providers[platform] = { roles: async (externalId, guildId) => {
        assert.equal(externalId, `${platform}_g05_alpha`); assert.equal(guildId, 'g05_fixture_guild');
        return { externalId, guildId, roleIds: ['g05_fixture_role'] };
      } };
      try {
        const community = api.v2Runtime.management.getSystem(identity).platformHost.community[platform];
        const value = await community.handle({ ticket, accountId: rootAccount.id });
        assert.equal(value.status, 'succeeded'); assert.equal(value.actorAccountId, 'g05_account_alpha');
        assert.equal(value.privacy, 'actor_only'); assert.equal(value.data.reference, publishedWipe.id);
        assert.deepEqual(await community.handle({ ticket }), value);
        const outsideTicket = ticket + '-outside';
        communityProofs.set(outsideTicket, { ...communityProofs.get(ticket), interactionId: outsideTicket, channelId: 'outside-channel' });
        await assert.rejects(() => community.handle({ ticket: outsideTicket }), error => error.errorCode === 'PLATFORM_CHANNEL_DENIED');
        checks.push({ route: `community-owner/${platform}`, sameMainScheduling: true, actorFromIsolatedVerifier: true,
          bodyAccountIgnored: true, privateReplay: true, outsideChannelRejected: true });
      } finally { identity.providers[platform] = originalProvider; }
    }
    const secretBody = { expectedRevision: 2, values: { appSecret: 'isolated-main-vault-secret' } };
    const secretSaved = await platformPost('wechat/secrets', secretBody, 'isolated-main-secret-save');
    assert.equal(secretSaved.revision, 3);
    const secretReplayed = await platformPost('wechat/secrets', secretBody, 'isolated-main-secret-save');
    assert.equal(secretReplayed.revision, 3);
    assert.equal(db.prepare("SELECT value FROM isolated_main_vault WHERE platform='wechat' AND field='appSecret'").get().value,
      'isolated-main-vault-secret');
    assert.ok(!JSON.stringify(secretSaved).includes('isolated-main-vault-secret'));
    const revokedBySecret = await fetch(`${origin}/api/v2/platform-media/share-code?metric=kda`, {
      headers: { Authorization: `Bearer ${rotatedAlphaToken}` } });
    assert.equal(revokedBySecret.status, 401);
    checks.push({ route: '/platform-admin/wechat/secrets', sameSqliteTransaction: true,
      replayKeepsRevision: 3, secretNotInResponse: true, priorMiniTokenRevoked: true, vault: 'explicit isolated table' });
    const rotateConfigResponse = await fetch(`${origin}/api/v2/platform-admin/wechat/config`, {
      method: 'POST', headers: { Cookie: rootCookie, 'X-CSRF-Token': rootLoginBody.data.csrfToken,
        Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'isolated-config-session-revoke' },
      body: JSON.stringify({ expectedRevision: 3, config: { minClientVersion: 2 } }) });
    assert.equal(rotateConfigResponse.status, 200, await rotateConfigResponse.text());
    const staleRootMini = await fetch(`${origin}/api/v2/mini-program/commands/me`, { method: 'POST',
      headers: { Authorization: `Bearer ${rootMiniToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{}' });
    assert.equal(staleRootMini.status, 401);
    checks.push({ route: '/platform-admin/wechat/config', committedConfigRevokesExistingMiniSession: true });
    for (const route of ['/member-admin/members', '/stats/wipes', '/sync-center/jobs', '/realtime/scopes', '/platform-admin', '/system-admin/access']) {
      const denied = await fetch(`${origin}/api/v2${route}`);
      assert.equal(denied.status, 401, route);
      const response = await fetch(`${origin}/api/v2${route}`, { headers });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      checks.push({ route, anonymous: denied.status, authenticated: response.status });
    }
    assert.equal((await fetch(`${origin}/api/v2/source-admin`)).status, 401);
    const sourceRead = await fetch(`${origin}/api/v2/source-admin/sources/steam`, {headers:{Cookie:rootCookie}});
    const sourceBody = await sourceRead.json(); assert.equal(sourceRead.status, 200, JSON.stringify(sourceBody));
    const sourceConfig = sourceBody.data;
    assert.equal(sourceConfig.runtimeStatusKnown, false);
    assert.equal(api.v2Runtime.management.getSystem(identity).sourceAdmin.identity, identity);
    const sourceCommand = {method:'POST', headers:{Cookie:rootCookie, Origin:origin, 'X-CSRF-Token':rootLoginBody.data.csrfToken,
      'Content-Type':'application/json', 'Idempotency-Key':randomUUID()},
      body:JSON.stringify({input:{expectedRevision:sourceConfig.revision,apiKey:'isolated-steam-key-20260908'}})};
    const sourceSave = await fetch(`${origin}/api/v2/source-admin/commands/steam.save`, sourceCommand);
    assert.equal(sourceSave.status,200, await sourceSave.text());
    const sourceReplay = await fetch(`${origin}/api/v2/source-admin/commands/steam.save`, sourceCommand);
    assert.equal(sourceReplay.status,200); assert.equal((await sourceReplay.json()).data.replayed,true);
    assert.equal(identity.repo.scalar('settings').steamWebApi.apiKey,'isolated-steam-key-20260908');
    checks.push({route:'/source-admin',sameIdentity:true,anonymousDenied:true,canonicalSaveAndReplay:true,runtimeUnknown:true});
    assert.equal((await fetch(`${origin}/api/v2/relay-admin`)).status,401);
    const relayState=await (await fetch(`${origin}/api/v2/relay-admin`,{headers:{Cookie:rootCookie}})).json();
    const relayCommand={method:'POST',headers:{Cookie:rootCookie,Origin:origin,'X-CSRF-Token':rootLoginBody.data.csrfToken,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({input:{expectedRevision:relayState.data.revision,token:'isolated-main-relay-token-32-bytes'}})};
    const relaySave=await fetch(`${origin}/api/v2/relay-admin/commands/save`,relayCommand);assert.equal(relaySave.status,200,await relaySave.text());
    assert.equal((await fetch(`${origin}/api/v2/relay-admin/commands/save`,relayCommand)).status,200);
    const relaySaved=await (await fetch(`${origin}/api/v2/relay-admin`,{headers:{Cookie:rootCookie}})).json();assert.equal(relaySaved.data.configured,true);assert.ok(!JSON.stringify(relaySaved).includes('isolated-main-relay-token'));
    const relayClear=await fetch(`${origin}/api/v2/relay-admin/commands/clear`,{...relayCommand,headers:{...relayCommand.headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({input:{expectedRevision:relaySaved.data.revision}})});assert.equal(relayClear.status,200,await relayClear.text());
    assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM json_scalars WHERE key='settings'").get().payload_json).rustplusRelay.tokenHash,'');
    checks.push({route:'/relay-admin',anonymousDenied:true,saveReplayClear:true,originalCacheInvalidatorBound:true});

    assert.equal(api.v2Runtime.management.getSystem(identity).members.identity, identity);
    assert.equal(api.v2Runtime.management.getSystem(identity).scheduling, api.v2Runtime.notifications.getScheduling(identity));
    assert.equal(api.v2Runtime.getMemberSpace(identity), api.v2Runtime.getMemberSpace(identity));
    assert.equal(api.v2Runtime.getMemberSpace(identity).scheduling, api.v2Runtime.notifications.getScheduling(identity));
    assert.equal((await fetch(`${origin}/api/v2/identity/accounts/isolated`, { method: 'PATCH' })).status, 410);
    const realtime = api.v2Runtime.management.getSystem(identity).realtime;
    realtime.repository.bind({ id: 'isolated-source', sourceId: 'constructed', serverKey: 'local',
      resource: { kind: 'squad', id: 'g05_squad' } });
    const url = `${origin}/api/v2/realtime/isolated-source/commands/clear-chat`;
    const command = { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json',
      'Idempotency-Key': 'isolated-clear-operation' }, body: JSON.stringify({ expectedRevision: 1, reason: 'isolated check' }) };
    assert.equal((await fetch(url, command)).status, 403);
    command.headers['X-CSRF-Token'] = session.csrfToken;
    const cleared = await fetch(url, command); const result = await cleared.json();
    assert.equal(cleared.status, 200, JSON.stringify(result));
    const replay = await fetch(url, command); const replayBody = await replay.json();
    assert.equal(replay.status, 200, JSON.stringify(replayBody));
    assert.equal(replayBody.data.replayed, true);
    assert.equal(realtime.repository.scope('isolated-source').revision, 2);
    checks.push({ route: '/realtime/isolated-source/commands/clear-chat', csrfDenied: true, mutation: true, replayWithoutSecondWrite: true });
    await api.v2Runtime.start();
    const stream = await fetch(`${origin}/api/v2/events`, { headers });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    try {
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: reset/);
      const system = api.v2Runtime.management.getSystem(identity).administration.service;
      const before = system.brand().revision;
      const brandCommand = { method: 'POST', headers: { ...headers, Origin: origin,
        'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ target: '', input: { expectedRevision: before } }) };
      const brandUrl = `${origin}/api/v2/system-admin/commands/brand.reset`;
      const saved = await fetch(brandUrl, brandCommand); const savedBody = await saved.json();
      assert.equal(saved.status, 200, JSON.stringify(savedBody));
      const replayed = await fetch(brandUrl, brandCommand); const replayedBody = await replayed.json();
      assert.equal(replayed.status, 200, JSON.stringify(replayedBody));
      assert.equal(replayedBody.data.replayed, true);
      assert.equal(system.brand().revision, before + 1);
      assert.equal((await store.readStore()).settings.system.teamLogoUrl, '');
      await api.v2Runtime.businessEvents.poll();
      assert.match(new TextDecoder().decode((await reader.read()).value), /domain_changed/);
      checks.push({ route: '/system-admin/commands/brand.reset', sameQueueCache: true, replay: true, sharedSse: true });
    } finally { await reader.cancel(); }
    const memberId = 'g05_alpha', targetAccount = repo.get('accounts', 'g05_account_alpha');
    assert.equal(targetAccount.memberId, memberId);
    const targetSession = identity.issueSession(targetAccount);
    const observeUrl = `${origin}/api/v2/member-adapters/members/${memberId}/unlink-observation?provider=discord`;
    assert.equal((await fetch(observeUrl)).status, 401);
    const observationResponse = await fetch(observeUrl, { headers });
    const observation = await observationResponse.json();
    assert.equal(observationResponse.status, 200, JSON.stringify(observation));
    assert.equal(observationResponse.headers.get('cache-control'), 'no-store');
    const unlinkUrl = `${origin}/api/v2/member-admin/members/${memberId}/unlink`;
    const unlinkInput = { provider: 'discord', reason: '隔离环境关联撤销验证',
      expectedRevision: observation.data.expectedRevision, expectedIdentityFingerprint: observation.data.expectedIdentityFingerprint };
    const commandHeaders = { ...headers, Origin: origin, 'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': randomUUID() };
    const conflict = await fetch(unlinkUrl, { method: 'POST', headers: commandHeaders,
      body: JSON.stringify({ ...unlinkInput, expectedIdentityFingerprint: '0'.repeat(64) }) });
    assert.equal(conflict.status, 409, await conflict.text());
    commandHeaders['Idempotency-Key'] = randomUUID();
    const unlinkCommand = { method: 'POST', headers: commandHeaders, body: JSON.stringify(unlinkInput) };
    const unlinked = await fetch(unlinkUrl, unlinkCommand), unlinkBody = await unlinked.json();
    assert.equal(unlinked.status, 200, JSON.stringify(unlinkBody));
    const unlinkReplay = await fetch(unlinkUrl, unlinkCommand), unlinkReplayBody = await unlinkReplay.json();
    assert.equal(unlinkReplay.status, 200, JSON.stringify(unlinkReplayBody));
    assert.equal(unlinkReplayBody.data.replayed, true);
    assert.equal(repo.get('identities', 'discord_alpha'), null);
    assert.ok(repo.get('identities', 'kook_alpha'));
    assert.equal(repo.get('bindings', 'binding_alpha').status, 'verified');
    const revoked = await fetch(`${origin}/api/v2/bootstrap`, { headers: { Cookie: `nb_v2_session=${targetSession.token}` } });
    assert.equal(revoked.status, 401);
    checks.push({ route: '/member-admin/members/:id/unlink', observedFingerprint: true, conflictRejected: true,
      singleQueueCommit: true, replay: true, sessionRevoked: true, otherProviderAndSteamPreserved: true });
    const brandService = api.v2Runtime.management.getSystem(identity).administration.service;
    const logoUpload = await fetch(`${origin}/api/v2/system-admin/commands/brand.upload`, {
      method: 'POST', headers: { ...commandHeaders, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ target: '', input: { expectedRevision: brandService.brand().revision,
        mimeType: 'image/png', data: pngFixture(16, 16).toString('base64') } }) });
    const logoResult = await logoUpload.json();
    assert.equal(logoUpload.status, 200, JSON.stringify(logoResult));
    const bootstrapResponse = await fetch(`${origin}/api/v2/bootstrap`, { headers });
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrap.data.brand.logoUrl, brandService.brand().teamLogoUrl);
    const logoResponse = await fetch(origin + bootstrap.data.brand.logoUrl, { headers });
    assert.equal(logoResponse.status, 200);
    assert.match(logoResponse.headers.get('content-type'), /^image\/png/);
    checks.push({ route: '/system-admin/commands/brand.upload', actualImageArtifact: true, sharedBootstrapLogo: true });
    const publicToken = randomBytes(24).toString('hex');
    const publicQuery = () => fetch(`${origin}/api/integrations/public-query`, { method: 'POST',
      headers: { Authorization: `Bearer ${publicToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamInput: repo.get('members', 'g05_beta').steamId }) });
    assert.equal((await publicQuery()).status, 401);
    const configurePublic = async (action, input) => {
      const response = await fetch(`${origin}/api/v2/system-admin/commands/${action}`, { method: 'POST',
        headers: { ...commandHeaders, Cookie: rootCookie, 'X-CSRF-Token': rootLoginBody.data.csrfToken,
          'Idempotency-Key': randomUUID() }, body: JSON.stringify({ target: '', input }) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    };
    await configurePublic('public.save', { expectedRevision: brandService.publicApi().revision, token: publicToken });
    const authorizedQuery = await publicQuery();
    assert.equal(authorizedQuery.status, 200, await authorizedQuery.text());
    assert.equal(authorizedQuery.headers.get('cache-control'), 'no-store');
    const assertTokenCurrent = await api.v2Runtime.management.authorizePublicToken(publicToken);
    await configurePublic('public.clear', { expectedRevision: brandService.publicApi().revision });
    assert.throws(assertTokenCurrent, { errorCode: 'PUBLIC_TOKEN_INVALID' });
    assert.equal((await publicQuery()).status, 401);
    checks.push({ route: '/integrations/public-query', canonicalSystemToken: true, existingResolverAndDto: true,
      clearInvalidatesInFlightProof: true, noImplicitProfileBackfill: true });
    if (process.env.MANAGEMENT_BROWSER === '1') {
      const loginPath = `/__fixture/${randomBytes(24).toString('hex')}`;
      app.get(loginPath, (req, res) => {
        res.clearCookie('nb_v2_session', { path: '/' });
        res.clearCookie('nb_v2_csrf', { path: '/' });
        res.cookie('nb_v2_session', session.token, { httpOnly: true, sameSite: 'lax', path: '/api/v2' });
        res.cookie('nb_v2_csrf', session.csrfToken, { httpOnly: true, sameSite: 'lax', path: '/api/v2' });
        res.redirect('/admin/members');
      });
      const dist = path.join(root, 'dist');
      app.use(express.static(dist, { dotfiles: 'deny' }));
      app.get(/^\/(admin|app|login|help)(\/.*)?$/, (req, res) => res.sendFile('index.html', { root: dist }));
      const ready = { origin, loginUrl: origin + loginPath, pid: process.pid, runDir: run,
        scope: 'Constructed admin login, actual G03/API/SQLite and built main UI; no external services' };
      await writeFile(path.join(run, 'browser-runtime.json'), JSON.stringify(ready, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(ready));
      await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
    }
  } finally {
    await api.v2Runtime.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    stopBackgroundJobs(); await store.drainStoreWrites(); await storage.closeSqliteDatabases();
  }
  assert.equal(api.v2Runtime.management.diagnostics().stopped, true);
  await writeFile(path.join(process.env.MANAGEMENT_RUN_DIR, 'report.json'), JSON.stringify({
    passed: true, scope: 'Actual API factory and G03 identity, six management domain reads, member unlink observation/conflict/replay/session revocation, system mutation/cache/SSE, realtime command and shutdown; isolated SQLite, configured sources disabled, browser acceptance separate', checks }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.join(process.env.MANAGEMENT_RUN_DIR, 'report.json') }));
}
