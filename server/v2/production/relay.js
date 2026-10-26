import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { createRelaySourceAdapter } from '../realtime/source.js';
import { normalizeRustplusRelayPayload } from '../../rustplus-relay.js';

const need = (condition, code, status = 503) => {
  if (!condition) throw new IdentityError(code, status);
};
const scopeIdFor = (source, server) => `relay_unassigned_${createHash('sha256')
  .update(JSON.stringify([source, server])).digest('hex')}`;

/** Authenticated ingress only. New sources remain unassigned and root-only;
 * neither the transport token nor a reported name grants squad membership. */
export function createProductionRelayIngress({ getRepository, runOperation, serializeWrite,
  isAccepting, normalizePayload = normalizeRustplusRelayPayload, now = Date.now }) {
  for (const fn of [getRepository, runOperation, serializeWrite, isAccepting, normalizePayload]) {
    need(typeof fn === 'function', 'PRODUCTION_RELAY_OWNER_REQUIRED');
  }
  return async function ingestRelay(input, { assertCredentialsCurrent } = {}) {
    need(isAccepting(), 'PRODUCTION_RELAY_NOT_READY');
    need(typeof assertCredentialsCurrent === 'function', 'PRODUCTION_RELAY_AUTH_REQUIRED', 401);
    const authenticate = () => {
      const result = assertCredentialsCurrent();
      if (result?.then) {
        result.catch?.(() => {});
        need(false, 'PRODUCTION_RELAY_SYNC_AUTH_REQUIRED');
      }
      need(result !== false, 'PRODUCTION_RELAY_AUTH_REQUIRED', 401);
    };
    return runOperation(() => {
      authenticate();
      const encoded = JSON.stringify(input);
      need(typeof encoded === 'string' && Buffer.byteLength(encoded) <= 256 * 1024, 'SOURCE_PAYLOAD_TOO_LARGE', 422);
      const receivedAt = new Date(now()).toISOString();
      const normalized = normalizePayload(JSON.parse(encoded), { receivedAt });
      const repo = getRepository();
      const existing = repo.scopes().find(row => row.source === normalized.client.id && row.server === normalized.server.key);
      // Capture before joining the write queue: queued old events must not adopt
      // a new epoch after a root clear/reset operation runs ahead of them.
      const admittedEpoch = existing?.epoch ?? 1;
      return serializeWrite(() => {
        need(isAccepting(), 'PRODUCTION_RELAY_NOT_READY');
        authenticate();
        return repo.transaction(() => {
          const rows = repo.scopes();
          let scope = rows.find(row => row.source === normalized.client.id && row.server === normalized.server.key);
          if (!scope) {
            need(rows.length < 500, 'SOURCE_CATALOG_LIMIT');
            const id = scopeIdFor(normalized.client.id, normalized.server.key);
            repo.bind({ id, sourceId: normalized.client.id, serverKey: normalized.server.key,
              resource: { kind: 'system', id: 'relay_unassigned' },
              label: `未分配 · ${normalized.server.name || normalized.server.key}` });
            scope = repo.scope(id);
          }
          const source = createRelaySourceAdapter({ repository: repo, normalizePayload: () => normalized, now });
          const result = source.ingest(scope.id, null, { sourceEpoch: admittedEpoch });
          return { event: { type: normalized.type, clientId: normalized.client.id, serverKey: normalized.server.key,
            receivedAt, inserted: result.accepted === true, skipped: result.ignored === true,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(normalized.type === 'clan_chat_message' ? { chatMessageId: normalized.id } : {}),
            ...(normalized.type === 'clan_invite_record' ? { inviteRecordId: normalized.id } : {}) } };
        });
      });
    });
  };
}
