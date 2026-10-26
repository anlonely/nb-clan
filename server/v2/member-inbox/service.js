import { createHmac, timingSafeEqual } from 'node:crypto';
import { MemberInboxRepository, need, hash } from './repository.js';

export const TEMPLATE_KEYS = Object.freeze(['wipeSignupStatus', 'wipeOpen', 'wipeReminder']);
const STATUSES = new Set(['accept', 'reject', 'ban', 'filter', 'unknown']);
const STATUS_TEXT = { pending: '待审核', approved: '已通过', rejected: '已拒绝', need_more: '需要补充资料' };
const revision = row => Number.isSafeInteger(row?.revision) && row.revision > 0 ? row.revision : 1;
const prefRevision = row => Number.isSafeInteger(row?.subscriptionPreferencesRevision) && row.subscriptionPreferencesRevision > 0 ? row.subscriptionPreferencesRevision : 1;
const short = (v, max = 160) => typeof v === 'string' ? v.slice(0, max) : '';
const body = (input, keys) => {
  need(input && typeof input === 'object' && !Array.isArray(input), 'INBOX_INPUT_INVALID');
  need(Object.keys(input).every(key => keys.includes(key)), 'INBOX_FIELD_NOT_WRITABLE');
};
const dto = row => row ? {
  id: row.id, type: short(row.type, 80), title: short(row.title, 120), body: short(row.body, 500),
  status: short(row.status, 20), statusText: STATUS_TEXT[row.status] || short(row.status, 20),
  applicationType: short(row.applicationType, 20), applicationId: short(row.applicationId, 120),
  targetId: short(row.targetId, 120), adminNote: short(row.adminNote, 500), templateKey: short(row.templateKey, 80),
  createdAt: short(row.createdAt, 40), readAt: short(row.readAt, 40), revision: revision(row)
} : null;

export class MemberInboxService {
  constructor({ identity, appId, readConfig, runStoreWriteTask, patchStoreCache, now = identity?.now || Date.now }) {
    need(identity?.repo?.db && typeof appId === 'string' && appId.length > 0 && appId.length <= 160 &&
      typeof readConfig === 'function' && typeof runStoreWriteTask === 'function' && typeof patchStoreCache === 'function', 'INBOX_HOST_REQUIRED', 503);
    Object.assign(this, { identity, appId, readConfig, runStoreWriteTask, patchStoreCache, now });
    this.repo = new MemberInboxRepository(identity.repo.db);
  }
  config() {
    const raw = this.readConfig({ appId: this.appId, db: this.repo.db });
    need(raw && !raw.then && raw.appId === this.appId && raw.enabled === true, 'INBOX_APP_UNAVAILABLE', 503);
    const templates = Object.fromEntries(TEMPLATE_KEYS.map(key => {
      const value = raw.subscriptionTemplates?.[key] || '';
      need(typeof value === 'string' && value.length <= 160, 'INBOX_CONFIG_INVALID', 503);
      return [key, value.trim()];
    }));
    return { templates, configRevision: hash([this.appId, raw.revision ?? null, templates]) };
  }
  context(actor, { assertCurrent } = {}) {
    if (assertCurrent) { const result = assertCurrent(); need(!result?.then, 'INBOX_SYNC_AUTH_REQUIRED', 503); }
    const a = this.identity.actorForAccount(actor?.id);
    need(a.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    const config = this.config();
    // The app is fixed by the host. No input field chooses an account or an
    // openid. Ambiguous same-app identities fail instead of choosing the first.
    const identities = this.repo.db.prepare(`SELECT payload_json FROM json_records WHERE collection='v2Identities'
      AND json_extract(payload_json,'$.accountId')=? AND json_extract(payload_json,'$.provider')=? ORDER BY id LIMIT 2`)
      .all(a.id, `wechat:${this.appId}`).map(r => JSON.parse(r.payload_json));
    need(identities.length === 1 && typeof identities[0].externalId === 'string' && identities[0].externalId,
      'INBOX_SUBJECT_UNAVAILABLE', 403);
    const mapping = identities[0];
    const users = this.repo.db.prepare(`SELECT payload_json FROM json_records WHERE collection='wechatUsers'
      AND json_extract(payload_json,'$.appId')=? AND (json_extract(payload_json,'$.openid')=? OR json_extract(payload_json,'$.openId')=?) ORDER BY id LIMIT 2`)
      .all(this.appId, mapping.externalId, mapping.externalId).map(r => JSON.parse(r.payload_json));
    need(users.length === 1, 'INBOX_SUBJECT_UNAVAILABLE', 403);
    const user = users[0], account = this.identity.repo.get('accounts', a.id);
    need(!user.openid || !user.openId || user.openid === user.openId, 'INBOX_SUBJECT_UNAVAILABLE', 403);
    need(!['blocked', 'disabled'].includes(user.status), 'ACCESS_RESTRICTED', 403);
    need(!user.accountId || user.accountId === a.id, 'INBOX_SUBJECT_UNAVAILABLE', 403);
    need(!user.memberId || user.memberId === account.memberId, 'INBOX_SUBJECT_UNAVAILABLE', 403);
    const subjectHash = hash([a.id, this.appId, user.id, mapping.id, mapping.externalId]);
    return { actor: a, user, config, subjectHash,
      scope: hash([subjectHash, a.permissionVersion, this.identity.scopeDigest(a), mapping.revision || 1]) };
  }
  settingsDTO(context) {
    const { user, config } = context;
    return { ...config, availableTemplateIds: [...new Set(Object.values(config.templates).filter(Boolean))],
      preferencesRevision: prefRevision(user), revision: prefRevision(user),
      subscriptions: Object.fromEntries(TEMPLATE_KEYS.map(key => {
        const p = user.subscriptionPreferences?.[key] || {}, templateId = config.templates[key];
        const matches = Boolean(templateId) && p.templateId === templateId;
        return [key, { status: matches ? short(p.status, 20) : '', templateId,
          updatedAt: short(p.updatedAt, 40), platformVerified: false,
          state: !p.templateId ? 'not_reported' : matches ? 'client_reported' : 'template_changed' }];
      })) };
  }
  settings(actor, input = {}, options) { body(input, []); return this.settingsDTO(this.context(actor, options)); }
  notification(context, id) {
    const row = this.repo.get('wechatNotifications', id);
    need(row && row.wechatUserId === context.user.id && (row.appId == null || row.appId === '' || row.appId === this.appId), 'RESOURCE_NOT_FOUND', 404);
    return row;
  }
  cursor(value) {
    const raw = Buffer.from(JSON.stringify(value)).toString('base64url');
    return raw + '.' + createHmac('sha256', this.repo.secret).update(raw).digest('base64url');
  }
  decode(value, scope) {
    try {
      need(typeof value === 'string' && value.length < 3000, 'CURSOR_EXPIRED', 410);
      const [raw, mac, extra] = value.split('.');
      const actual = Buffer.from(mac || '', 'base64url'), expected = createHmac('sha256', this.repo.secret).update(raw).digest();
      need(!extra && actual.length === expected.length && timingSafeEqual(actual, expected), 'CURSOR_EXPIRED', 410);
      const c = JSON.parse(Buffer.from(raw, 'base64url'));
      need(c.v === 1 && c.scope === scope && Number.isFinite(c.sort) && typeof c.id === 'string' &&
        c.at <= this.now() && this.now() - c.at <= 86400000, 'CURSOR_EXPIRED', 410);
      return c;
    } catch { need(false, 'CURSOR_EXPIRED', 410); }
  }
  list(actor, input = {}, options) {
    body(input, ['limit', 'cursor']);
    const c = this.context(actor, options), limit = input.limit === undefined ? 20 : Number(input.limit);
    need(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'INBOX_INVALID_PAGE');
    const after = input.cursor ? this.decode(input.cursor, c.scope) : null;
    const order = "COALESCE(julianday(json_extract(payload_json,'$.createdAt')),0)";
    const scope = "collection='wechatNotifications' AND json_extract(payload_json,'$.wechatUserId')=? AND (COALESCE(json_extract(payload_json,'$.appId'),'')='' OR json_extract(payload_json,'$.appId')=?)";
    const rows = this.repo.db.prepare(`SELECT id,payload_json,${order} AS sort FROM json_records WHERE ${scope}
      ${after ? `AND (${order}<? OR (${order}=? AND id<?))` : ''} ORDER BY ${order} DESC,id DESC LIMIT ?`)
      .all(c.user.id, this.appId, ...(after ? [after.sort, after.sort, after.id] : []), limit + 1);
    const notifications = rows.slice(0, limit).map(r => dto(JSON.parse(r.payload_json)));
    const totals = this.repo.db.prepare(`SELECT count(*) AS total,sum(CASE WHEN COALESCE(json_extract(payload_json,'$.readAt'),'')='' THEN 1 ELSE 0 END) AS unread FROM json_records WHERE ${scope}`).get(c.user.id, this.appId);
    const latest = this.repo.db.prepare(`SELECT payload_json FROM json_records WHERE ${scope} ORDER BY ${order} DESC,id DESC LIMIT 1`).get(c.user.id, this.appId);
    const last = rows[Math.min(rows.length, limit) - 1];
    return { notifications, latestNotification: latest ? dto(JSON.parse(latest.payload_json)) : null,
      total: totals.total, unread: totals.unread || 0, countScope: 'self',
      nextCursor: rows.length > limit ? this.cursor({ v: 1, scope: c.scope, sort: last.sort, id: last.id, at: after?.at ?? this.now() }) : null };
  }
  async write(actor, action, input, options, perform) {
    const { operationId, assertCurrent } = options || {};
    need(typeof operationId === 'string' && /^[A-Za-z0-9_.:-]{8,160}$/.test(operationId), 'OPERATION_ID_REQUIRED');
    const initial = this.context(actor, { assertCurrent });
    const fingerprint = hash([action, input]);
    return this.runStoreWriteTask(async () => {
      const result = this.repo.transaction(() => {
        const c = this.context(actor, { assertCurrent });
        need(c.scope === initial.scope, 'PERMISSIONS_CHANGED', 401);
        const prior = this.repo.db.prepare('SELECT * FROM v2_member_inbox_receipts WHERE account_id=? AND app_id=? AND operation_id=?').get(c.actor.id, this.appId, operationId);
        if (prior) {
          need(prior.subject_hash === c.subjectHash, 'RESOURCE_NOT_FOUND', 404);
          need(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 409);
          return { ...JSON.parse(prior.payload), replayed: true };
        }
        const { change, resourceRevision } = perform(c);
        const operationReceipt = { operationId, action, resourceId: change.id, revision: resourceRevision, committedAt: new Date(this.now()).toISOString() };
        const payload = { operationReceipt, change, replayed: false };
        this.repo.db.prepare('INSERT INTO v2_member_inbox_receipts VALUES(?,?,?,?,?,?)').run(c.actor.id, this.appId, operationId, c.subjectHash, fingerprint, JSON.stringify(payload));
        this.repo.db.prepare('INSERT INTO v2_member_inbox_audit(account_id,app_id,subject_hash,operation_id,action,resource_id,revision,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(c.actor.id, this.appId, c.subjectHash, operationId, action, change.id, resourceRevision, operationReceipt.committedAt);
        return payload;
      });
      const { collection, id } = result.change;
      // The only cache patch is the canonical record re-read after commit.
      const current = this.repo.get(collection, id);
      await this.patchStoreCache(store => {
        const rows = store[collection] ||= [], at = rows.findIndex(r => r.id === id);
        if (!current) { if (at >= 0) rows.splice(at, 1); }
        else if (at >= 0) rows[at] = current; else rows.push(current);
      });
      const context = this.context(actor, { assertCurrent });
      need(context.scope === initial.scope, 'PERMISSIONS_CHANGED', 401);
      return { operationReceipt: result.operationReceipt, replayed: result.replayed,
        current: action === 'preferences.save' ? this.settingsDTO(context) : dto(this.notification(context, id)) };
    });
  }
  saveSettings(actor, input, options) {
    body(input, ['expectedRevision', 'expectedConfigRevision', 'subscriptions', 'preferences']);
    need(!(input.subscriptions && input.preferences), 'INBOX_INPUT_INVALID');
    const source = input.subscriptions || input.preferences;
    need(source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length <= 10, 'INBOX_INPUT_INVALID');
    need(Object.entries(source).every(([k,v]) => k.length <= 160 && typeof v === 'string' && v.length <= 20), 'INBOX_INPUT_INVALID');
    return this.write(actor, 'preferences.save', input, options, c => {
      need(input.expectedRevision === prefRevision(c.user), 'REVISION_CONFLICT', 409);
      need(input.expectedConfigRevision === c.config.configRevision, 'INBOX_CONFIG_CHANGED', 409);
      const patch = {}, stamp = new Date(this.now()).toISOString();
      for (const [field, raw] of Object.entries(source)) {
        const keys = TEMPLATE_KEYS.includes(field) ? [field] : TEMPLATE_KEYS.filter(k => c.config.templates[k] === field);
        need(keys.length > 0 && keys.every(k => c.config.templates[k]), 'INBOX_TEMPLATE_UNAVAILABLE');
        const value = raw.trim(); need(value, 'INBOX_INPUT_INVALID');
        for (const key of keys) {
          const status = STATUSES.has(value) ? value : 'unknown';
          need(!patch[key] || patch[key].status === status, 'INBOX_PREFERENCE_CONFLICT');
          patch[key] = { status, templateId: c.config.templates[key], updatedAt: stamp, platformVerified: false, reportSource: 'client_preference' };
        }
      }
      need(Object.keys(patch).length > 0, 'INBOX_EMPTY_PATCH');
      const resourceRevision = prefRevision(c.user) + 1;
      this.repo.put('wechatUsers', { ...c.user, subscriptionPreferences: { ...c.user.subscriptionPreferences, ...patch },
        subscriptionPreferencesRevision: resourceRevision, revision: revision(c.user) + 1, updatedAt: stamp });
      return { change: { collection: 'wechatUsers', id: c.user.id }, resourceRevision };
    });
  }
  markRead(actor, id, input, options) {
    body(input, ['expectedRevision']);
    need(typeof id === 'string' && id.length > 0 && id.length <= 160, 'INBOX_INPUT_INVALID');
    return this.write(actor, 'notification.read', { id, ...input }, options, c => {
      const old = this.notification(c, id);
      need(input.expectedRevision === revision(old), 'REVISION_CONFLICT', 409);
      const next = old.readAt ? old : { ...old, readAt: new Date(this.now()).toISOString(), revision: revision(old) + 1 };
      if (!old.readAt) this.repo.put('wechatNotifications', next);
      return { change: { collection: 'wechatNotifications', id }, resourceRevision: revision(next) };
    });
  }
}
