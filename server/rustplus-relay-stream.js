import { WebSocket, WebSocketServer } from 'ws';
import {
  RUSTPLUS_RELAY_MAX_PAYLOAD_BYTES,
  RUSTPLUS_RELAY_STREAM_ENDPOINT,
  ingestRustplusRelayPayload,
  readRustplusRelaySettingsRuntimeStore,
  recordRustplusRelayError,
  validateRustplusRelayToken
} from './rustplus-relay.js';
import { nowIso } from './store.js';
import { createIntegrationEvent, rustplusIntegrationEventInput } from './integration-events.js';

const RUSTPLUS_RELAY_STREAM_PROTOCOL_VERSION = 1;
const RUSTPLUS_RELAY_STREAM_MAX_BATCH = 20;
const RUSTPLUS_RELAY_STREAM_MAX_PAYLOAD_BYTES = Math.max(RUSTPLUS_RELAY_MAX_PAYLOAD_BYTES, 512 * 1024);
const RUSTPLUS_RELAY_STREAM_HEARTBEAT_MS = 30_000;
const RUSTPLUS_RELAY_STREAM_TYPES = [
  'clan_snapshot',
  'clan_chat_message',
  'clan_invite_record',
  'member_online',
  'member_offline',
  'member_joined',
  'member_left'
];

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function parseWsJson(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  if (!text.trim()) {
    throw Object.assign(new Error('WebSocket payload is empty'), { status: 400 });
  }
  if (Buffer.byteLength(text, 'utf8') > RUSTPLUS_RELAY_STREAM_MAX_PAYLOAD_BYTES) {
    throw Object.assign(new Error(`WebSocket payload exceeds ${RUSTPLUS_RELAY_STREAM_MAX_PAYLOAD_BYTES} bytes`), { status: 413 });
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('WebSocket payload must be a JSON object'), { status: 400 });
  }
  return payload;
}

function relayWsEventEnvelope(input = {}) {
  const type = String(input.type || input.event || input.kind || '').trim();
  if (type === 'relay_event') {
    const event = input.payload || input.data || input.eventPayload || input.eventData || {};
    return {
      event,
      eventId: String(input.eventId || input.id || event.eventId || event.id || event.messageId || '').trim()
    };
  }
  return {
    event: input,
    eventId: String(input.eventId || input.id || input.messageId || '').trim()
  };
}

function relayWsEventsFromMessage(message = {}) {
  const type = String(message.type || message.event || message.kind || '').trim();
  if (type === 'heartbeat' || type === 'ping') return { heartbeat: true };
  if (type === 'relay_batch') {
    const events = Array.isArray(message.events) ? message.events : [];
    if (!events.length) {
      throw Object.assign(new Error('relay_batch.events is empty'), { status: 400 });
    }
    if (events.length > RUSTPLUS_RELAY_STREAM_MAX_BATCH) {
      throw Object.assign(new Error(`relay_batch.events max size is ${RUSTPLUS_RELAY_STREAM_MAX_BATCH}`), { status: 400 });
    }
    return {
      batchId: String(message.batchId || message.id || '').trim(),
      events: events.map(relayWsEventEnvelope)
    };
  }
  return { events: [relayWsEventEnvelope(message)] };
}

function writeUpgradeError(socket, status, message) {
  const statusText = status === 503 ? 'Service Unavailable' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Unauthorized';
  const body = JSON.stringify({ ok: false, error: message || statusText });
  socket.write([
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
  socket.destroy();
}

async function handleRelayWsEvent(ws, req, envelope, { onRelayPayload, relayIngest, authenticateRelay }) {
  const eventId = envelope.eventId || '';
  try {
    if (relayIngest) {
      const assertCredentialsCurrent = await authenticateRelay(req);
      assertCredentialsCurrent();
      const payload = await relayIngest(envelope.event, { transport: 'websocket', eventId, assertCredentialsCurrent });
      return { type: 'ack', ok: true, eventId, relayEvent: payload.event };
    }
    const payload = await ingestRustplusRelayPayload(envelope.event);
    await createIntegrationEvent(rustplusIntegrationEventInput(envelope.event, payload, null, {
      transport: 'websocket',
      eventId
    }), { dedupe: true }).catch(() => null);
    if (onRelayPayload) {
      onRelayPayload(req, payload).catch((error) => {
        recordRustplusRelayError(error?.message || 'Rust+ relay WebSocket Discord forward failed').catch(() => {});
      });
    }
    return {
      type: 'ack',
      ok: true,
      eventId,
      relayEvent: payload.event
    };
  } catch (error) {
    if (relayIngest) return { type: 'ack', ok: false, eventId, error: error?.errorCode || 'RUSTPLUS_RELAY_INGEST_FAILED' };
    await recordRustplusRelayError(error?.message || 'Rust+ relay WebSocket payload failed').catch(() => {});
    await createIntegrationEvent(rustplusIntegrationEventInput(envelope.event, {}, error, {
      transport: 'websocket',
      eventId
    }), { dedupe: true }).catch(() => null);
    return {
      type: 'ack',
      ok: false,
      eventId,
      error: error?.message || 'Rust+ relay WebSocket payload failed'
    };
  }
}

export function installRustplusRelayWebSocket(server, options = {}) {
  const onRelayPayload = options.onRelayPayload || null;
  const relayIngest = options.relayIngest, authenticateRelay = options.authenticateRelay;
  if (relayIngest !== undefined && (typeof relayIngest !== 'function' || typeof authenticateRelay !== 'function')) throw new TypeError('RELAY_INGEST_OWNER_INVALID');
  const pending = new Set(); let draining = false, drainPromise;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: RUSTPLUS_RELAY_STREAM_MAX_PAYLOAD_BYTES
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname !== RUSTPLUS_RELAY_STREAM_ENDPOINT) return;
    if (draining) { writeUpgradeError(socket, 503, 'RUSTPLUS_RELAY_STOPPING'); return; }
    const job = (async () => {
    try {
      if (relayIngest) { const assertCurrent = await authenticateRelay(req); assertCurrent(); }
      else await validateRustplusRelayToken(req, await readRustplusRelaySettingsRuntimeStore({ includeCounts: false }));
      if (draining) { writeUpgradeError(socket, 503, 'RUSTPLUS_RELAY_STOPPING'); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (error) {
      const status = Number(error?.status) || 401;
      if (!relayIngest) await recordRustplusRelayError(error?.message || 'Rust+ relay WebSocket auth failed').catch(() => {});
      writeUpgradeError(socket, status, relayIngest ? error?.errorCode || 'RUSTPLUS_RELAY_AUTH_FAILED' : error?.message || 'Rust+ relay WebSocket auth failed');
    }
    })();
    pending.add(job);
    job.finally(() => pending.delete(job)).catch(() => {});
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    sendJson(ws, {
      type: 'hello',
      ok: true,
      protocolVersion: RUSTPLUS_RELAY_STREAM_PROTOCOL_VERSION,
      acceptedTypes: RUSTPLUS_RELAY_STREAM_TYPES,
      serverTime: nowIso()
    });
    ws.on('message', (data) => {
      if (draining) { ws.close(1001, 'Server stopping'); return; }
      const job = (async () => {
      let message;
      try {
        message = parseWsJson(data);
        const request = relayWsEventsFromMessage(message);
        if (request.heartbeat) {
          sendJson(ws, { type: 'pong', ok: true, serverTime: nowIso() });
          return;
        }
        const results = [];
        for (const envelope of request.events) {
          results.push(await handleRelayWsEvent(ws, req, envelope, { onRelayPayload, relayIngest, authenticateRelay }));
        }
        if (request.batchId) {
          sendJson(ws, { type: 'batch_ack', ok: results.every((item) => item.ok), batchId: request.batchId, results });
        } else {
          sendJson(ws, results[0]);
        }
      } catch (error) {
        if (!relayIngest) await recordRustplusRelayError(error?.message || 'Rust+ relay WebSocket message failed').catch(() => {});
        sendJson(ws, {
          type: 'error',
          ok: false,
          eventId: String(message?.eventId || message?.id || '').trim(),
          error: relayIngest ? error?.errorCode || 'RUSTPLUS_RELAY_INVALID_PAYLOAD' : error?.message || 'Rust+ relay WebSocket message failed'
        });
      }
      })();
      pending.add(job);
      job.finally(() => pending.delete(job)).catch(() => {});
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, RUSTPLUS_RELAY_STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));
  wss.drain = () => drainPromise ||= (async () => {
    draining = true; clearInterval(heartbeat);
    const closed = new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    for (const ws of wss.clients) ws.close(1001, 'Server stopping');
    await Promise.all([...pending, closed]);
  })();

  return wss;
}
