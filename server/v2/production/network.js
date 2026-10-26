import nodeFetch from 'node-fetch';
import { ReadableStream } from 'node:stream/web';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { IdentityError } from '../identity/errors.js';
import { selectedProxyUrl } from '../../proxy-nodes.js';

// Readable.toWeb in Node 22 can enqueue a queued data event after cancel has
// closed its controller. Read in paused mode and fence every terminal path
// before destroying the source; a late event must never touch the controller.
function responseBodyToWeb(body, signal) {
  let controller, terminal = false, reading = false;
  const cleanup = () => {
    body.off('readable', pump); body.off('end', end); body.off('close', close);
    signal?.removeEventListener('abort', abort);
    // Keep the error listener: node-fetch/pipeline may emit again after destroy.
  };
  const finish = error => {
    if (terminal) return;
    terminal = true; cleanup();
    const current = controller; controller = null;
    if (error) current.error(error); else current.close();
  };
  const fail = error => { finish(error); if (!body.destroyed) body.destroy(); };
  function end() { finish(); }
  function close() {
    if (body.readableEnded) end();
    else fail(Object.assign(new Error('Response body closed prematurely'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
  }
  function abort() { fail(signal.reason || new DOMException('The operation was aborted.', 'AbortError')); }
  function pump() {
    if (terminal || reading) return;
    reading = true;
    try {
      while (!terminal && controller.desiredSize > 0) {
        const chunk = body.read();
        // read() may synchronously trigger cancellation, error or completion.
        if (terminal || chunk === null) break;
        controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
      }
    } catch (error) { fail(error); }
    finally { reading = false; }
  }
  body.pause();
  return new ReadableStream({
    start(value) {
      controller = value;
      body.on('error', fail); body.on('readable', pump); body.on('end', end); body.on('close', close);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (body.errored) fail(body.errored);
      else if (body.readableEnded) end();
      else if (body.destroyed) close();
    },
    pull: pump,
    cancel() {
      if (terminal) return;
      terminal = true; cleanup(); controller = null;
      if (!body.destroyed) body.destroy();
    }
  }, { highWaterMark: Math.max(1, body.readableHighWaterMark || 16384), size: chunk => chunk.byteLength });
}

export function createProductionNetwork({ readSettings, env = process.env, fetchImpl = nodeFetch }) {
  const agents = new Map();
  function proxyFor(service) {
    const proxy = readSettings()?.system?.proxy || {};
    if (proxy.enabled === false) return '';
    if ((proxy.url || proxy.nodeId) && (proxy.scope === 'global' || !proxy.scope || proxy.scope === service)) {
      try { return selectedProxyUrl(proxy); }
      catch { throw new IdentityError('PROXY_UNAVAILABLE', 503); }
    }
    return env[`NB_${service.toUpperCase()}_PROXY_URL`] || env.NB_PROXY_URL || '';
  }
  function agentFor(value) {
    if (!value) return undefined;
    if (agents.has(value)) return agents.get(value);
    let url, agent;
    try {
      url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol)) agent = new HttpsProxyAgent(url);
      else if (['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)) agent = new SocksProxyAgent(url);
      else throw new Error();
    } catch { throw new IdentityError('PROXY_UNAVAILABLE', 503); }
    if (agents.size >= 16) {
      const oldest = agents.keys().next().value;
      agents.get(oldest).destroy(); agents.delete(oldest);
    }
    agents.set(value, agent); return agent;
  }
  async function webFetch(url, options) {
    const response = await fetchImpl(url, options);
    // Source providers consume WHATWG streams; node-fetch is retained for proxy
    // agents. Adapt its body without buffering so existing byte/abort limits work.
    if (!response.body || typeof response.body.getReader === 'function') return response;
    const bodyless = [204, 205, 304].includes(response.status);
    if (bodyless) response.body.destroy();
    const converted = new Response(bodyless ? null : responseBodyToWeb(response.body, options?.signal), {
      status: response.status, statusText: response.statusText, headers: response.headers
    });
    Object.defineProperties(converted, { url: { value: response.url }, redirected: { value: response.redirected } });
    return converted;
  }
  const proxyFetch = (url, options = {}) => {
    const { proxyUrl, ...request } = options;
    // A caller may still hold a proxy URL from before the master switch changed.
    const enabled = readSettings()?.system?.proxy?.enabled !== false;
    return webFetch(url, { ...request, redirect: 'error', agent: enabled ? agentFor(proxyUrl) : undefined });
  };
  const serviceFetch = (service, url, options = {}) => proxyFetch(url, { ...options, proxyUrl: proxyFor(service) });
  return { proxyFor, proxyFetch, serviceFetch, fetchImpl: webFetch,
    stop() { for (const agent of agents.values()) agent.destroy(); agents.clear(); } };
}
