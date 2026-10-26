import { IdentityError } from '../identity/errors.js';
import { decodedRealtimeNames } from './names.js';
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
export const memberDTO = m => decodedRealtimeNames(pick(m, ['steamId', 'displayName', 'avatar', 'role', 'online', 'lastOnlineAt', 'lastOfflineAt', 'lastSeenAt', 'onlineTimeMinutes', 'gameClanName']), ['displayName', 'gameClanName']);
export const chatDTO = m => decodedRealtimeNames(pick(m, ['id', 'steamId', 'displayName', 'message', 'translatedMessage', 'channel', 'sentAt', 'receivedAt']), ['displayName']);
export const inviteDTO = m => decodedRealtimeNames(pick(m, ['id', 'steamId', 'displayName', 'inviterSteamId', 'inviterName', 'invitedBy', 'inviteeSteamId', 'inviteeName', 'status', 'statusLabel', 'sentAt', 'firstSeenAt', 'acceptedAt', 'receivedAt']), ['displayName', 'inviterName', 'invitedBy', 'inviteeName']);
const inviteContent = value => { const { receivedAt, ...content } = value; return JSON.stringify(content); };
/** Explicit owner-only source bridge. Pass the existing normalizeRustplusRelayPayload function.
 * Never imports the legacy runtime or triggers collection from a read request. */
export function createRelaySourceAdapter({
  repository: repo,
  normalizePayload,
  now = Date.now
} = {}) {
  return {
    ingest(scopeId, input, {
      sourceEpoch
    } = {}) {
      if (!normalizePayload) throw new IdentityError('SOURCE_ADAPTER_REQUIRED', 503);
      const s = repo.scope(scopeId);
      if (!s) throw new IdentityError('RESOURCE_NOT_FOUND', 404);
      if (sourceEpoch !== s.epoch) throw new IdentityError('SOURCE_EPOCH_CHANGED', 409);
      const receivedAt = new Date(now()).toISOString(),
        n = normalizePayload(input, {
          receivedAt
        });
      if (n.client?.id !== s.source || n.server?.key !== s.server) throw new IdentityError('SOURCE_SCOPE_MISMATCH', 422);
      if (Buffer.byteLength(JSON.stringify(n)) > 256 * 1024) throw new IdentityError('SOURCE_PAYLOAD_TOO_LARGE', 422);
      const at = n.capturedAt || n.occurredAt || n.acceptedAt || n.sentAt || receivedAt;
      if (s.cutoff && (n.resetCutoffAt || at) <= s.cutoff) return {
        ignored: true,
        reason: 'before_reset'
      };
      const result = repo.transaction(() => {
        if (n.type === 'clan_snapshot') {
          if (s.watermark && at <= s.watermark) return {
            ignored: true,
            reason: 'stale_snapshot'
          };
          const snapshot = {
            ...(n.expiresAt ? { expiresAt: n.expiresAt } : {}),
            clan: pick(n.clan, ['id', 'name', 'memberLimit', 'announcement']),
            members: (n.members || []).slice(0, 500).map(memberDTO),
            invites: (n.invites || []).slice(0, 250).map(inviteDTO)
          };
          repo.db.prepare('UPDATE v2_realtime_scopes SET snapshot=?,observed=?,received=?,watermark=?,revision=revision+1 WHERE id=?').run(JSON.stringify(snapshot), at, receivedAt, at, s.id);
          repo.emit(s.id, 'roster.changed', {}, now());
        } else if (['member_online', 'member_offline', 'member_joined', 'member_left'].includes(n.type)) {
          // A delta is not a full-roster observation; it cannot revive a stale snapshot.
          if (!s.snapshot || s.watermark && at < s.watermark) return {
            ignored: true,
            reason: 'snapshot_required'
          };
          const snapshot = s.snapshot,
            id = n.member.steamId,
            old = snapshot.members.find(m => m.steamId === id);
          if (old?.lastSeenAt && at < old.lastSeenAt) return {
            ignored: true,
            reason: 'stale_member_delta'
          };
          snapshot.members = snapshot.members.filter(m => m.steamId !== id);
          if (n.type !== 'member_left') snapshot.members.push({
            ...old,
            ...memberDTO(n.member),
            lastSeenAt: at
          });
          if (snapshot.members.length > 500) throw new IdentityError('SOURCE_SNAPSHOT_REQUIRED', 409);
          repo.db.prepare('UPDATE v2_realtime_scopes SET snapshot=?,received=?,watermark=?,revision=revision+1 WHERE id=?').run(JSON.stringify(snapshot), receivedAt, at, s.id);
          repo.emit(s.id, 'roster.changed', {}, now());
        } else {
          const kind = n.type === 'clan_chat_message' ? 'chat' : n.type === 'clan_invite_record' ? 'invite' : null;
          if (!kind || !n.id) throw new IdentityError('INVALID_SOURCE_EVENT', 422);
          if (kind === 'chat' && repo.db.prepare('SELECT 1 FROM v2_realtime_seen WHERE scope=? AND id=?').get(s.id, n.id)) return {
            ignored: true,
            reason: 'duplicate_or_cleared'
          };
          const payload = kind === 'chat' ? chatDTO(n) : inviteDTO(n),
            existing = repo.db.prepare('SELECT * FROM v2_realtime_records WHERE scope=? AND kind=? AND id=?').get(s.id, kind, n.id);
          const previousInvite = existing && kind === 'invite' ? JSON.parse(existing.payload) : null;
          if (existing && (kind === 'chat' || inviteContent(previousInvite) === inviteContent(payload) || at < existing.occurred || previousInvite.status === 'accepted' && payload.status === 'pending' && (n.resetCutoffAt !== undefined || at <= existing.occurred))) return {
            ignored: true,
            reason: 'duplicate_or_stale'
          };
          if (existing) repo.db.prepare('UPDATE v2_realtime_records SET payload=?,occurred=?,received=? WHERE seq=?').run(JSON.stringify(payload), at, receivedAt, existing.seq);else repo.db.prepare('INSERT INTO v2_realtime_records(scope,kind,id,occurred,received,payload) VALUES(?,?,?,?,?,?)').run(s.id, kind, n.id, at, receivedAt, JSON.stringify(payload));
          if (kind === 'chat') repo.db.prepare('INSERT INTO v2_realtime_seen VALUES(?,?)').run(s.id, n.id);
          repo.emit(s.id, kind === 'chat' ? 'chat.created' : 'invites.changed', kind === 'chat' ? payload : {}, now());
          repo.db.prepare('UPDATE v2_realtime_scopes SET revision=revision+1 WHERE id=?').run(s.id);
        }
        repo.db.prepare('UPDATE v2_realtime_scopes SET sourceName=?,firstReceived=COALESCE(firstReceived,?),lastReport=? WHERE id=?').run(n.client.name || s.source, receivedAt, receivedAt, s.id);
        return {
          accepted: true
        };
      });
      if (result.accepted) repo.notify(s.id);
      return result;
    }
  };
}
