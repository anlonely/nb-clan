import nodeFetch from 'node-fetch';
import { buildNativeNotificationRequest, buildNativePrivateResponseRequest } from '../notification-platforms/platforms.js';

const origins = Object.freeze({ discord: 'https://discord.com', kook: 'https://www.kookapp.cn' });
const failure = code => Object.assign(new Error(code), { transportCode: code, errorCode: code });
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);

/** Fixed native endpoints only. No retry: the original worker owns retry/unknown decisions. */
export function createProductionNotificationTransport({ readCredentials, fetchImpl = nodeFetch, validateTarget,
  privateTimeoutMs = 15000, maxResponseBytes = 1048576 } = {}) {
  if (typeof readCredentials !== 'function' || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(privateTimeoutMs) || privateTimeoutMs < 1 || privateTimeoutMs > 120000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 8388608) {
    throw failure('NOTIFICATION_TRANSPORT_CONFIG_INVALID');
  }
  async function execute(platform, wire, { signal, timeoutMs, privateDiscord = false }) {
    if (!Object.hasOwn(origins, platform) || !wire.path.startsWith(platform === 'discord' ? '/api/v10/' : '/api/v3/')) {
      throw failure('NOTIFICATION_ENDPOINT_INVALID');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw failure('PLATFORM_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      // Discord's interaction webhook uses its verified, private path token.
      if (!privateDiscord) {
        const credentials = readCredentials(platform);
        if (!credentials || typeof credentials.then === 'function' || !secret(credentials.botToken)) throw failure('NOTIFICATION_CREDENTIALS_REQUIRED');
        headers.authorization = `Bot ${credentials.botToken}`;
      }
      const response = await fetchImpl(origins[platform] + wire.path, {
        method: wire.method, headers, ...(wire.body === null ? {} : { body: JSON.stringify(wire.body) }),
        signal: controller.signal, redirect: 'error', size: maxResponseBytes
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== origins[platform])) throw failure('NOTIFICATION_REDIRECT_REJECTED');
      const chunks = []; let length = 0;
      for await (const chunk of response.body || []) {
        const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > maxResponseBytes) { controller.abort(); throw failure('NOTIFICATION_RESPONSE_TOO_LARGE'); }
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw.length) { try { body = JSON.parse(raw); } catch { throw failure('NOTIFICATION_RESPONSE_INVALID'); } }
      return { status: response.status, body, headers: Object.fromEntries(
        ['x-request-id', 'retry-after', 'x-rate-limit-reset'].flatMap(key => {
          const value = response.headers.get(key); return value === null ? [] : [[key, value]];
        })) };
    } catch {
      // Never propagate fetch errors: a private URL or proxy credential may be present.
      throw failure(controller.signal.aborted ? signal?.aborted ? 'PLATFORM_ABORTED' : 'PLATFORM_TIMEOUT' : 'PLATFORM_TRANSPORT_ERROR');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({ runtimeMode: 'production',
    async request(args) {
      if (validateTarget) validateTarget(args.target);
      const wire = buildNativeNotificationRequest({ ...args, runtimeMode: 'production' });
      return execute(args.platform, wire, { signal: args.context.signal, timeoutMs: args.context.timeoutMs });
    },
    async respondPrivate(args) {
      const wire = buildNativePrivateResponseRequest(args);
      const response = await execute(args.platform, wire, { signal: args.signal, timeoutMs: privateTimeoutMs,
        privateDiscord: args.platform === 'discord' });
      const body = args.platform === 'discord' ? response.body : response.body?.data;
      const id = args.platform === 'discord' ? body?.id : body?.msg_id;
      if (response.status !== 200 || typeof id !== 'string' || !id ||
          (args.platform === 'kook' && response.body?.code !== 0) ||
          (args.platform === 'discord' && body.channel_id !== args.verifiedInteraction.channelId)) {
        throw failure('PRIVATE_RESPONSE_UNKNOWN');
      }
      return { messageId: id };
    }
  });
}
