import { need, safeText, signature, text } from './model.js';
const sources = { audit: 'logs', runtime: 'operationRuns' };
const groupExpr = `CASE WHEN typ IN ('login','login_failed','query','query_failed','public_api_query') THEN 'access'
  WHEN typ LIKE 'sync_%' OR typ IN ('battlemetrics_playtime_sync','battlemetrics_id_refresh','kda_sync','member_profile_sync','member_profile_sync_cancel') THEN 'sync'
  WHEN typ LIKE 'discord_%' OR typ LIKE 'kook_%' OR typ LIKE 'rustplus_%' THEN 'integrations'
  WHEN typ LIKE 'wechat_%' OR typ LIKE 'member_bind_request_%' THEN 'wechat'
  WHEN typ LIKE 'squad_%' THEN 'squads' WHEN typ LIKE 'wipe_%' THEN 'wipes'
  WHEN typ LIKE 'member_%' OR typ LIKE 'join_application_%' OR typ LIKE 'account_%' THEN 'members'
  WHEN typ LIKE 'user_%' OR typ LIKE 'permission_%' OR typ LIKE 'system_%' OR typ LIKE 'account.%' OR typ LIKE 'role.%'
    OR typ LIKE 'brand.%' OR typ LIKE 'storage.%' OR typ LIKE 'proxy.%' OR typ LIKE 'public.%' OR typ LIKE 'logs.%'
    OR typ IN ('third_party_login_settings_edit','public_api_token_edit','battlemetrics_api_key_edit','steam_web_api_key_edit','export') THEN 'system' ELSE 'other' END`;
const actions = {'brand.save':'保存品牌设置','brand.reset':'恢复默认徽标','brand.upload':'上传战队徽标','brand.upload.start':'开始上传徽标','brand.upload.part':'上传徽标分片','brand.upload.finish':'完成徽标上传','brand.upload.abort':'取消徽标上传','proxy.save':'保存代理配置','proxy.select':'选择代理节点','proxy.toggle':'切换代理总开关','proxy.probe':'执行代理检测','public.save':'轮换公开 API 密钥','public.clear':'停用公开 API','account.create':'创建网站账号','account.password':'更新账号密码','account.status':'更新账号状态','account.role':'分配站内角色','account.batch':'批量管理账号','account.grants':'修改账号授权','account.binding':'登记候选关联','account.restriction':'设置访问限制','account.delete':'停用并保留账号记录','account.cleanup':'清理失联成员账号','role.save':'保存角色矩阵','role.delete':'删除自定义角色','storage.backup':'创建数据库备份','storage.restore':'生成恢复副本','storage.quarantine':'文件移入隔离区','storage.recover':'恢复隔离文件','storage.export-config':'导出脱敏配置','logs.export':'导出日志'};
export function readSystemLogs(repo, actor, query = {}) {
  const source = query.source || 'audit'; need(['audit', 'runtime', 'system'].includes(source), 'INVALID_LOG_SOURCE');
  const q = text(query.q || '', 120), type = text(query.type || '', 80), group = text(query.group || '', 30);
  need(!group || ['access','sync','integrations','wechat','squads','wipes','members','system','other'].includes(group), 'INVALID_LOG_GROUP');
  const from = query.from || '1970-01-01T00:00:00.000Z', to = query.to || '9999-01-01T00:00:00.000Z';
  need(Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(from) < Date.parse(to), 'INVALID_LOG_RANGE');
  const start = new Date(from).toISOString(), end = new Date(to).toISOString(), limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
  const binding = signature(repo.meta('signatureKey'), { actor: actor.id, permissions: actor.permissionVersion, source, q, type, group, start, end });
  let cursor;
  if (query.cursor) {
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()); } catch {}
    need(cursor && typeof cursor.time === 'string' && typeof cursor.id === 'string' && cursor.binding === binding &&
      cursor.mac === signature(repo.meta('signatureKey'), { time: cursor.time, id: cursor.id, binding }), 'CURSOR_EXPIRED', 410);
  }
  const select = source === 'system' ? `SELECT id, created_at ts, action typ, actor_id actor, action summary, result status, operation_id op, target target FROM v2_system_audits`
    : `SELECT id, coalesce(json_extract(payload_json,'$.createdAt'),'') ts, coalesce(json_extract(payload_json,'$.type'),'') typ,
      coalesce(json_extract(payload_json,'$.actorUsername'),json_extract(payload_json,'$.createdBy'),'') actor,
      coalesce(json_extract(payload_json,'$.summary'),json_extract(payload_json,'$.errorSummary'),json_extract(payload_json,'$.type'),'') summary,
      coalesce(json_extract(payload_json,'$.status'),'') status, coalesce(json_extract(payload_json,'$.operationId'),id) op, coalesce(json_extract(payload_json,'$.targetId'),'') target
      FROM json_records WHERE collection='${sources[source]}'`;
  const rows = repo.db.prepare(`WITH entries AS (${select}), grouped AS (SELECT *, ${groupExpr} grp FROM entries)
    SELECT * FROM grouped WHERE ts>=? AND ts<? AND (?='' OR typ=?) AND (?='' OR grp=?)
    AND (?='' OR instr(lower(typ||' '||actor||' '||summary),lower(?))>0)
    AND (?='' OR ts<? OR ts=? AND id<?) ORDER BY ts DESC,id DESC LIMIT ?`).all(start, end, type, type, group, group, q, q,
      cursor?.time || '', cursor?.time || '', cursor?.time || '', cursor?.id || '', limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  const next = last && rows.length > limit ? { time: last.ts, id: last.id, binding } : null;
  return { source, items: page.map(r => ({ id: r.id, createdAt: r.ts, type: safeText(r.typ, 80), actor: safeText(r.actor, 100),
    summary: actions[r.typ] || safeText(r.summary), target: safeText(r.target,160), status: safeText(r.status, 40), group: r.grp, operationId: r.op })),
    nextCursor: next ? Buffer.from(JSON.stringify({ ...next, mac: signature(repo.meta('signatureKey'), next) })).toString('base64url') : null,
    range: { from: start, to: end }, limit };
}
export function logsCSV(page) {
  const cell = x => '"' + String(x ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
  return '\ufeff' + [['时间','类型','操作者','摘要','状态','操作编号'], ...page.items.map(r => [r.createdAt,r.type,r.actor,r.summary,r.status,r.operationId])].map(row => row.map(cell).join(',')).join('\r\n');
}
