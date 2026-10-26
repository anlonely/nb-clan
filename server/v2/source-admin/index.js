import { runStoreWriteTask, patchStoreCache as originalPatchStoreCache } from '../../store.js';
import { IdentityError } from '../identity/errors.js';
import { authorize, can } from '../identity/permissions.js';
import { isTrustedRoot } from '../system-admin/access.js';
import { signature, SystemError } from '../system-admin/model.js';
import { SourceAdminRepository } from './repository.js';
import { need, SourceAdminError, SOURCES, ACTIONS, section, revisionFor, bmKeys, safeLabel, applyCommand, fields, operationId } from './model.js';
export { installSourceAdminSchema } from './repository.js';
export { createSourceAdminRouter } from './routes.js';
const resource = { kind: 'system', id: 'api_keys' };
const syncLink = '/admin/sync';
const mapping = {
  battlemetrics: ['玩家身份匹配与在线时长使用同一组密钥。', '时长任务绑定档期服务器的 BattleMetrics ID、成员 BattleMetrics ID 及固定采集时间窗。', '已创建任务保留原凭据摘要；轮换后旧窗口会拒绝继续，需重新创建任务。'],
  steam: ['Web API Key 用于公开资料、封禁、游戏统计及库存等适配器读取。', 'Steam OpenID 登录和已验证身份绑定独立于 Web API Key；资料可见性不代表身份已验证。'],
  kda: ['服务器/Wipe 对应关系来自档期的服务器快照。', 'Vital 仅在宿主接入对应 reader 后可用；manual/none 不会自动采集。', 'Moose 还需要宿主提供受控引擎；此页不创建外部查询或 VIP 能力。']
};
/** No factory migration, environment reads, timers or second write queue. */
export function createSourceAdmin({ identity, patchStoreCache = originalPatchStoreCache, readRuntimeStatus = () => ({}) } = {}) {
  need(identity?.repo?.db && typeof patchStoreCache === 'function' && typeof readRuntimeStatus === 'function', 'SOURCE_ADMIN_HOST_REQUIRED', 503);
  const repo = new SourceAdminRepository(identity.repo.db), pending = new Set(); let accepting = false, started = false;
  function ready() { need(accepting, 'SOURCE_ADMIN_STOPPED', 503); }
  function actorFor(actor, mutation = false) {
    ready(); const current = identity.actorForAccount(actor?.id);
    authorize(current, 'system.api_keys', resource, identity.relations());
    if (mutation) need(isTrustedRoot(identity, current), 'ROOT_REQUIRED', 403);
    return current;
  }
  function status(source) {
    const raw = readRuntimeStatus(source);
    need(raw && !raw.then && typeof raw === 'object', 'SOURCE_STATUS_UNAVAILABLE', 503);
    // Only booleans cross this seam. Never return raw host/provider status or credentials.
    return { providerAvailable: raw.providerAvailable === true, injectedCredentialConfigured: raw.injectedCredentialConfigured === true,
      runtimeStatusKnown: typeof raw.providerAvailable === 'boolean' && typeof raw.injectedCredentialConfigured === 'boolean' };
  }
  function current(source, settings) {
    const raw = settings[section(source)] || {}, runtime = status(source);
    const keys = source === 'battlemetrics' ? bmKeys(raw, repo.signatureKey) : [];
    const configured = source === 'battlemetrics' ? keys.length > 0 : source === 'steam' ? Boolean(raw.apiKey) : false;
    const effectiveSource = source === 'battlemetrics' && !runtime.runtimeStatusKnown ? 'unknown' : source === 'battlemetrics' && runtime.injectedCredentialConfigured ? 'injected' : configured ? 'settings' : runtime.injectedCredentialConfigured ? 'injected' : runtime.runtimeStatusKnown ? 'none' : 'unknown';
    return { id: source, name: { battlemetrics: 'BattleMetrics', steam: 'Steam', kda: 'KDA 来源' }[source],
      revision: revisionFor(repo.signatureKey, source, settings), storeConfigured: configured, masked: configured ? '********' : '',
      ...(source === 'battlemetrics' ? { keys: keys.map((k, i) => ({ id: k.id, label: safeLabel(k.label, settings) || `Token ${i + 1}`, masked: '********', primary: i === 0 })), primaryKeyId: keys[0]?.id || null } : {}),
      ...runtime, effectiveSource, connectionVerified: false, connectionStatus: 'not_verified', mapping: mapping[source],
      capabilities: source === 'battlemetrics' ? ['玩家身份匹配', '档期在线时长'] : source === 'steam' ? ['公开资料', '账号封禁', '游戏统计', '库存读取'] : ['按服务器与 Wipe 读取战绩'],
      runtimeNote: runtime.providerAvailable ? '采集适配器已接入，外部连接尚未验证。' : runtime.runtimeStatusKnown ? '采集服务尚未接入，保存凭据不会启用采集。' : '采集服务状态尚未接入，保存凭据不会启动采集。' };
  }
  async function run(fn) {
    ready();
    // The imported original store queue is shared with ALL legacy settings writes.
    const work = runStoreWriteTask(async () => { ready(); try { return await fn(); } catch (e) {
      // Original queue records error.message in metrics; sanitize before crossing it.
      if (e instanceof SourceAdminError) throw e;
      if (e instanceof SystemError || e instanceof IdentityError) throw new SourceAdminError(e.errorCode, e.status);
      throw new SourceAdminError(['ACCESS_DENIED','AUTH_CHANGED','SESSION_EXPIRED','SESSION_INVALID','SESSION_REVOKED'].includes(e?.errorCode) ? e.errorCode : 'SOURCE_ADMIN_UNAVAILABLE', e?.errorCode ? e.status || 503 : 503);
    } });
    pending.add(work); try { return await work; } finally { pending.delete(work); }
  }
  async function authenticateCurrent(actor, authenticate) {
    if (authenticate) { const state = await authenticate(); need(state?.actor?.id === actor.id, 'AUTH_CHANGED', 401); }
    return actorFor(actor, true);
  }
  async function flush() {
    // Always re-read latest canonical settings, including on an older operation replay.
    const settings = repo.settings();
    try { await patchStoreCache(store => { store.settings = structuredClone(settings); }); }
    catch { throw new SourceAdminError('CACHE_REFRESH_REQUIRED', 503); }
  }
  const receipt = o => ({ operationId: o.id, action: o.action, state: 'succeeded', ...o.result, cacheState: 'not_checked' });
  const service = {
    identity, repo,
    start() { need(!started, 'SOURCE_ADMIN_ALREADY_STARTED', 503); started = true; accepting = true; },
    async stop() { accepting = false; await Promise.allSettled([...pending]); },
    read(actor, source) {
      actor = actorFor(actor); need(!source || SOURCES.includes(source), 'RESOURCE_NOT_FOUND', 404);
      const settings = repo.settings(), write = isTrustedRoot(identity, actor);
      const runRecordsHref = can(actor, 'sync.read', { kind: 'system', id: 'sync' }, identity.relations()) ? syncLink : null;
      const project = id => ({ ...current(id, settings), canWrite: write && id !== 'kda', runRecordsHref });
      return source ? project(source) : { items: SOURCES.map(project) };
    },
    getOperation(actor, id) { actor = actorFor(actor, true); const op = repo.operation(operationId(id)); need(op?.actorId === actor.id, 'RESOURCE_NOT_FOUND', 404); return receipt(op); },
    async command(actor, action, input, id, { authenticate } = {}) {
      actor = actorFor(actor, true); need(ACTIONS.includes(action), 'UNKNOWN_SOURCE_COMMAND', 404);
      fields(input, ['expectedRevision','id','apiKey','label']); id = operationId(id);
      need(typeof input.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(input.expectedRevision), 'EXPECTED_REVISION_REQUIRED');
      // Snapshot caller input before queueing; never persist plaintext request bodies.
      input = structuredClone(input); const actorId = actor.id;
      const sig = signature(repo.signatureKey, { actorId, action, input });
      return run(async () => {
        actor = await authenticateCurrent(actor, authenticate);
        const prior = repo.operation(id);
        if (prior) { need(prior.actorId === actorId && prior.signature === sig, 'OPERATION_CONFLICT', 409); await flush(); return { ...receipt(prior), replayed: true, cacheState: 'refreshed' }; }
        const op = repo.transaction(() => {
          actorFor(actor, true); const settings = repo.settings(), source = action.split('.')[0];
          need(input.expectedRevision === revisionFor(repo.signatureKey, source, settings), 'REVISION_CONFLICT', 409);
          const changed = applyCommand(settings, action, input, repo.signatureKey);
          repo.saveSettings(settings);
          const op = { id, actorId, action, signature: sig, result: { ...changed, revision: revisionFor(repo.signatureKey, source, settings), connectionVerified: false } };
          repo.saveOperation(op); return op;
        });
        await flush(); return { ...receipt(op), cacheState: 'refreshed' };
      });
    },
    async recover(actor, id, { authenticate } = {}) {
      actor = actorFor(actor, true); id = operationId(id);
      return run(async () => { actor = await authenticateCurrent(actor, authenticate); const op = repo.operation(id);
        need(op?.actorId === actor.id, 'RESOURCE_NOT_FOUND', 404); await flush(); return { ...receipt(op), replayed: true, cacheState: 'refreshed' }; });
    }
  };
  return Object.freeze(service);
}
