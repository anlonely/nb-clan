import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { fixture as hostFixture } from '../v2-platform-host/fixture.mjs';
import { createPlatformConfigReaders } from '../../../server/v2/management-adapters/platform-config/index.js';
import { MemberInboxService, installMemberInboxSchema } from '../../../server/v2/member-inbox/index.js';
import { createPlatformMediaOwner, installPlatformMediaSchema } from '../../../server/v2/platform-media/index.js';

export const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// Deterministic 1x1 opaque PNG used only as an isolated media response.
const chunk = (name, body) => {
  const data = Buffer.concat([Buffer.from(name), body]); let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const out = Buffer.alloc(data.length + 8); out.writeUInt32BE(body.length); data.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
};
const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
export const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 24, 60, 90, 255]))), chunk('IEND', Buffer.alloc(0))]);
export const response = () => ({ status: 200, headers: new Headers({ 'content-type': 'image/png' }), body: (async function* () { yield png; })() });

export async function fixture({ filename = ':memory:', miniExchange, mediaExchange, getAccessToken } = {}) {
  let f, readers;
  f = hostFixture({ filename, options: { wechat: { appId: 'host_app', readConfig: () => readers.readMini(),
    exchangeCode: args => miniExchange ? miniExchange(args) : Promise.resolve({ appId: args.appId,
      verified: true, openid: `openid-${f.proofCodes.get(args.code)}` }) } } });
  readers = createPlatformConfigReaders({ identity: f.identity, platformService: f.platformService, appId: 'host_app' });
  const state = { vaultWrites: 0, failVault: false, failAfterVault: false, tokens: [], images: [] };
  f.db.exec('CREATE TABLE platform_config_fixture_vault(platform TEXT,field TEXT,value TEXT,PRIMARY KEY(platform,field))');
  f.platformService.adapters.vault = { writeSync({ db, platform, values }) {
    assert.equal(db, f.db); assert.equal(db.isTransaction, true); state.vaultWrites++;
    if (state.failVault) throw new Error('isolated vault failure');
    for (const [key, value] of Object.entries(values)) db.prepare('INSERT INTO platform_config_fixture_vault VALUES(?,?,?) ON CONFLICT(platform,field) DO UPDATE SET value=excluded.value').run(platform, key, value);
    if (state.failAfterVault) throw new Error('isolated post-vault failure');
  } };
  installMemberInboxSchema(f.db); installPlatformMediaSchema(f.db);
  const inbox = new MemberInboxService({ identity: f.identity, appId: 'host_app', readConfig: readers.readInbox,
    runStoreWriteTask: f.runStoreWriteTask, patchStoreCache: f.patchStoreCache, now: f.now });
  const media = createPlatformMediaOwner({ identity: f.identity, memberSpace: f.memberSpace, appId: 'host_app', readConfig: readers.readMedia,
    runStoreWriteTask: f.runStoreWriteTask, patchStoreCache: f.patchStoreCache, now: f.now,
    getAccessToken: async args => {
      state.tokens.push({ appId: args.appId, generation: args.generation });
      return getAccessToken ? getAccessToken(args) : { appId: args.appId, generation: args.generation, accessToken: 'isolated-media-token' };
    },
    exchangeCode: async args => {
      state.images.push({ appId: args.appId, generation: args.generation, scene: args.scene });
      return mediaExchange ? mediaExchange(args) : response();
    } });
  await f.start();
  f.ir.put('wechatUsers', { id: 'wx-config-member', appId: 'host_app', openid: 'openid-member', memberId: 'm002', status: 'approved', revision: 1 });
  let sequence = 0;
  // Same post-commit contract already owned by management-runtime. Test-only
  // composition; the reader never patches or replaces the root implementation.
  const notify = revision => {
    const id = `platform-config:wechat:${revision}`;
    f.host.invalidatePlatformSessions({ id, reason: 'platform_configuration_changed', appId: 'host_app' });
  };
  const write = (method, input, { operationId = `config-operation-${++sequence}`, invalidate = true } = {}) =>
    f.runStoreWriteTask(() => { const result = f.platformService[method](f.actor('admin'), 'wechat', input, { operationId }); if (invalidate) notify(result.revision); return result; });
  const save = (config, options = {}) => write('save', { expectedRevision: options.expectedRevision ?? f.platformService.config('wechat').revision, config }, options);
  const secrets = (value = 'constructed-secret-only', options = {}) => write('secrets', { expectedRevision: options.expectedRevision ?? f.platformService.config('wechat').revision, values: { appSecret: value } }, options);
  const mediaArgs = (session, input = {}) => ({ actor: f.host.mini.authenticate(session).actor, input,
    assertCurrent: () => f.host.mini.authenticate(session).actor,
    subject: () => { const r = f.host.mini.authenticate(session); return { verified: true, appId: r.session.appId, externalId: r.session.externalId, accountId: r.actor.id }; } });
  return { ...f, readers, inbox, media, state, save, secrets, write, notify, mediaArgs,
    close: async () => { await media.stop(); await f.close(); }
  };
}
