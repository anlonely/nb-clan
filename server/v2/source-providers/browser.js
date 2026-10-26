import puppeteer from 'puppeteer-core';
import { randomUUID } from 'node:crypto';
import { requireFact, fault, safeError } from './transport.js';

/** Every browser HTTP response is fulfilled by the owner's bounded transport. Native egress is sent to a dead loopback proxy. */
export async function withControlledPage({ session, executablePath, task }) {
  requireFact(typeof executablePath === 'string' && executablePath.startsWith('/'), 'SOURCE_NOT_CONFIGURED');
  let browser, page, closing, mainTarget, launch; const pending = new Set(), sockets = new Map();
  const track = p => { pending.add(p); p.then(() => pending.delete(p), e => { pending.delete(p); session.fail(e); }); return p; };
  const close = () => closing ||= (async () => { for (const socket of sockets.values()) socket.close(); if (browser) await browser.close().catch(() => {}); })();
  const onAbort = () => { void close(); }; session.signal.addEventListener('abort', onAbort, { once:true });
  session.onClose(async () => {
    await launch?.catch(()=>{});
    // close() may have run while launch was still pending; its first promise then had no browser.
    if (browser && !browser.connected) await closing;
    else if (browser) { closing = null; await close(); }
    await Promise.allSettled([...pending]);
  });
  try {
    session.check();
    launch = puppeteer.launch({ executablePath, headless:true, pipe:true, env:{}, timeout:10000,
      args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check',
        '--disable-extensions','--disable-domain-reliability','--disable-client-side-phishing-detection','--disable-breakpad',
        '--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP * ~NOTFOUND',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-quic','--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater'] }).then(value => (browser = value));
    await launch;
    // Abort may arrive during launch: close the newly created browser before any navigation.
    if (session.signal.aborted) { closing = null; await close(); session.check(); }
    const context = await browser.createBrowserContext();
    page = await context.newPage(); mainTarget = page.target();
    browser.on('targetcreated', target => { if (target !== mainTarget) track(target.page().then(p => p?.close())); });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable'); await cdp.send('Network.setBlockedURLs',{urls:['ws://*','wss://*','file://*','ftp://*']});
    await cdp.send('Browser.setDownloadBehavior',{behavior:'deny',browserContextId:context.id});
    await page.setBypassServiceWorker(true); await page.setCacheEnabled(false);
    await page.setViewport({width:1440,height:1800}); page.setDefaultTimeout(12000);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const frameId = frameTree.frame.id;
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    cdp.on('Fetch.requestPaused', event => {
      track((async () => {
        try {
          session.check();
          const request = event.request;
          if (['Image','Font','Media'].includes(event.resourceType)) { await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}); return; }
          requireFact(event.frameId === frameId, 'SOURCE_URL_REJECTED');
          const contentType = Object.entries(request.headers).find(([k])=>k.toLowerCase()==='content-type')?.[1];
          let body;
          // CDP postDataEntries are base64 bytes. Puppeteer's postData() decodes them as UTF-8 and would corrupt SignalR binary HTTP.
          if (request.postDataEntries?.length) {
            requireFact(request.postDataEntries.length<=32 && request.postDataEntries.every(p=>typeof p.bytes==='string' && p.bytes.length<=44000),'SOURCE_RESPONSE_TOO_LARGE');
            body=Buffer.concat(request.postDataEntries.map(p=>Buffer.from(p.bytes,'base64')));
          } else if (request.hasPostData) {
            requireFact(typeof request.postData==='string' && contentType!=='application/octet-stream'); body=request.postData;
          }
          const result = await session.request(request.url, {method:request.method,body,contentType});
          session.check();
          const headers = {'content-type':result.contentType,'cache-control':'no-store','x-content-type-options':'nosniff'};
          if (event.resourceType==='Document') headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
          await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:result.status,responseHeaders:Object.entries(headers).map(([name,value])=>({name,value})),body:result.body.toString('base64')});
        } catch(e) { await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{}); session.fail(e); }
      })());
    });
    const bridge = `nbMoose${randomUUID().replaceAll('-','')}`;
    await page.exposeFunction(bridge, (operation,id,payload) => {
      try {
      session.check();
      if (operation === 'policy') { session.fail(fault('SOURCE_URL_REJECTED')); return; }
      requireFact(Number.isSafeInteger(id) && id > 0 && id <= 2);
      if (operation === 'open') {
        requireFact(!sockets.has(id));
        const ws = session.socket(payload.url,payload.protocols,event => { track(page.evaluate((key,id,event) => window[key](id,event),bridge+'Event',id,event)); });
        sockets.set(id,ws);
      } else if (operation === 'send') { requireFact(sockets.has(id)); sockets.get(id).send(payload.data,payload.binary); }
      else if (operation === 'close') sockets.get(id)?.close();
      else throw fault('SOURCE_INVALID_DATA');
      } catch (error) { throw session.fail(error); }
    });
    await page.evaluateOnNewDocument(key => {
      const sockets = new Map(); let sequence = 0;
      const bytes64 = bytes => { let s=''; for (let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); };
      class OwnedSocket extends EventTarget {
        static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
        CONNECTING=0; OPEN=1; CLOSING=2; CLOSED=3; readyState=0; protocol=''; extensions=''; binaryType='blob'; bufferedAmount=0;
        constructor(url,protocols=[]) { super(); this.url=String(url); this.id=++sequence; sockets.set(this.id,this);
          window[key]('open',this.id,{url:this.url,protocols:typeof protocols==='string'?[protocols]:protocols}).catch(()=>this.emit('error',new Event('error'))); }
        emit(type,event) { this.dispatchEvent(event); this['on'+type]?.(event); }
        send(data) { if(this.readyState!==1) throw new DOMException('Socket is not open','InvalidStateError');
          const binary=typeof data!=='string'; const ready=data instanceof Blob?data.arrayBuffer():Promise.resolve(data);
          void ready.then(value=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array(value);
            if(bytes.length>262144) throw new Error('Frame too large'); return window[key]('send',this.id,{data:bytes64(bytes),binary});}).catch(()=>this.emit('error',new Event('error'))); }
        close() { this.readyState=2; void window[key]('close',this.id,{}); }
      }
      Object.defineProperty(window,'WebSocket',{value:OwnedSocket,writable:false,configurable:false});
      for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport','Worker','SharedWorker']) Object.defineProperty(window,name,{value:class { constructor(){throw new DOMException('Unavailable in source reader','SecurityError');} },writable:false,configurable:false});
      window.addEventListener('securitypolicyviolation',event=>{if(['connect-src','script-src-elem','frame-src','worker-src','form-action'].includes(event.effectiveDirective))void window[key]('policy',0,{}).catch(()=>{});});
      Object.defineProperty(window,key+'Event',{value:(id,event)=>{ const s=sockets.get(id);if(!s)return;
        if(event.type==='open'){s.readyState=1;s.protocol=event.protocol;s.emit('open',new Event('open'));}
        if(event.type==='close'){s.readyState=3;s.emit('close',new CloseEvent('close',{code:event.code,wasClean:event.code===1000}));}
        if(event.type==='message'){const bytes=Uint8Array.from(atob(event.data),x=>x.charCodeAt(0));s.emit('message',new MessageEvent('message',{data:event.binary?(s.binaryType==='arraybuffer'?bytes.buffer:new Blob([bytes])):new TextDecoder().decode(bytes)}));}
      }});
      window.open=()=>null;
    }, bridge);
    session.check(); const result = await task(page); session.check(); return result;
  } catch(e) { try { session.check(); } catch(s) { throw safeError(s); } throw safeError(e); }
  finally { session.signal.removeEventListener('abort',onAbort); await close(); await Promise.allSettled([...pending]); await session.close(); }
}
