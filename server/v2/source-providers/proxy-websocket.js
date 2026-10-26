import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { requireFact, fault } from './transport.js';
/** Explicit opt-in factory for the validated transport; no ambient proxy or authentication state. */
export function openProxyWebSocket(url, protocols, options) {
  let agent;
  try {
    const proxy=new URL(options.proxyUrl),target=new URL(url),origin=new URL(options.headers?.origin);
    requireFact(['ws:','wss:'].includes(target.protocol) && origin.origin===target.origin.replace(/^ws/,'http') && target.pathname==='/_blazor' && !target.username&&!target.password,'SOURCE_URL_REJECTED');
    if(['http:','https:'].includes(proxy.protocol))agent=new HttpsProxyAgent(proxy);
    else if(['socks:','socks4:','socks4a:','socks5:','socks5h:'].includes(proxy.protocol))agent=new SocksProxyAgent(proxy);
    else throw fault('PROXY_UNAVAILABLE');
    const socket=new WebSocket(url,protocols,{agent,headers:{origin:origin.origin},followRedirects:false,handshakeTimeout:options.handshakeTimeout,maxPayload:options.maxPayload,perMessageDeflate:false});
    socket.once('close',()=>agent.destroy());return socket;
  }catch{agent?.destroy();throw fault('PROXY_UNAVAILABLE');}
}
