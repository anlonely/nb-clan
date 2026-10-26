import { readSqliteCollectionRecord } from '../../storage/sqlite-migrate.js';

/** Keep the legacy cache current inside the shared store queue, after SQLite
 * has committed. The durable member outbox remains responsible for recovery;
 * this adapter neither consumes it nor changes the Steam command's receipt. */
export function createDiscordSteamMemberTeamWriter({ identity, runStoreWriteTask, patchStoreCache }) {
  if (!identity?.repo?.db || typeof runStoreWriteTask !== 'function' || typeof patchStoreCache !== 'function')
    throw new TypeError('Existing identity, store queue and cache adapters required');
  const db = identity.repo.db;
  let retryFrom = null;
  const position = () => Number(db.prepare('SELECT COALESCE(max(seq),0) seq FROM v2_member_admin_outbox').get().seq);
  async function refresh(from) {
    // Never project uncommitted data, including an unsuccessful rollback.
    if (db.isTransaction || from === null) return;
    const rows = db.prepare('SELECT payload FROM v2_member_admin_outbox WHERE seq>? ORDER BY seq').all(from);
    const changes = new Map();
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      if (payload.schemaVersion !== 1 || !Array.isArray(payload.changes)) continue;
      for (const change of payload.changes) if (['members', 'squadMembers'].includes(change.collection) &&
        typeof change.id === 'string' && change.id.length > 0 && change.id.length <= 200)
        changes.set(`${change.collection}:${change.id}`, { collection: change.collection, id: change.id });
    }
    if (!changes.size) { retryFrom = null; return; }
    const current = [...changes.values()].map(change => ({ ...change,
      record: readSqliteCollectionRecord(db, change.collection, change.id) }));
    await patchStoreCache(store => {
      // Prepare each replacement before assigning either collection, so a bad
      // cache shape cannot apply half of a member/squad refresh.
      const updated = new Map();
      for (const change of current) {
        if (!updated.has(change.collection)) updated.set(change.collection, [...(store[change.collection] || [])]);
        const collection = updated.get(change.collection), index = collection.findIndex(row => row.id === change.id);
        if (!change.record) { if (index >= 0) collection.splice(index, 1); }
        else if (index >= 0) collection[index] = change.record;
        else collection.push(change.record);
      }
      for (const [collection, records] of updated) store[collection] = records;
    });
    retryFrom = null;
  }
  return function writeMemberTeam(work) {
    if (typeof work !== 'function') throw new TypeError('Synchronous Steam-link write required');
    return runStoreWriteTask(async () => {
      if (db.isTransaction) throw new Error('STEAM_TEAM_WRITER_TRANSACTION_OPEN');
      let before = retryFrom;
      // A missing/unreadable optional outbox must not prevent saving the bot
      // declaration. Website-sync errors are handled by the owner's savepoint.
      if (before === null) try { before = position(); } catch {}
      try {
        const result = work();
        if (result?.then) throw new TypeError('Synchronous Steam-link write required');
        return result;
      } finally {
        try { await refresh(before); }
        catch {
          // Retain the cursor for a later attempt; reread current DB rows then,
          // never replay old record snapshots. An already committed Steam link
          // remains successful even when this optional cache refresh fails.
          retryFrom = before;
        }
      }
    });
  };
}
