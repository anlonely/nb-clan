import { need } from './model.js';

// Apply filters before the rowid cursor and limit. The audit payload remains its
// original, safe projection; missing historical target/feature fields stay absent.
export function readAuditPage(repo, platform, query = {}) {
  const allowed = new Set(['cursor', 'limit', 'action', 'status', 'from', 'to']);
  need(query && typeof query === 'object' && !Array.isArray(query) && Object.keys(query).every(key => allowed.has(key)), 'PLATFORM_INPUT_INVALID');
  for (const [key, value] of Object.entries(query)) need((typeof value === 'string' || ['cursor', 'limit'].includes(key) && typeof value === 'number') && String(value).length <= 100, 'PLATFORM_INPUT_INVALID');
  const limit = query.limit === undefined ? 30 : Number(query.limit);
  const cursor = query.cursor ? Number(query.cursor) : Number.MAX_SAFE_INTEGER;
  need(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 && Number.isSafeInteger(cursor) && cursor > 0, 'PLATFORM_INPUT_INVALID');
  for (const key of ['action', 'status']) need(!query[key] || /^[a-z][a-z0-9_]{0,79}$/.test(query[key]), 'PLATFORM_INPUT_INVALID');
  for (const key of ['from', 'to']) need(!query[key] || /^\d{4}-\d{2}-\d{2}T/.test(query[key]) && Number.isFinite(Date.parse(query[key])), 'PLATFORM_INPUT_INVALID');
  need(!query.from || !query.to || Date.parse(query.from) < Date.parse(query.to), 'PLATFORM_INPUT_INVALID');
  const where = ["kind='audit'", 'platform=?', 'rowid<?'], args = [platform, cursor];
  for (const key of ['action', 'status']) if (query[key]) { where.push(`json_extract(payload,'$.${key}')=?`); args.push(query[key]); }
  if (query.from) { where.push('at>=?'); args.push(Date.parse(query.from)); }
  if (query.to) { where.push('at<?'); args.push(Date.parse(query.to)); }
  const rows = repo.db.prepare(`SELECT rowid,payload FROM platform_admin_records WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...args, limit + 1);
  return { items: rows.slice(0, limit).map(row => JSON.parse(row.payload)), nextCursor: rows.length > limit ? String(rows[limit - 1].rowid) : null };
}
