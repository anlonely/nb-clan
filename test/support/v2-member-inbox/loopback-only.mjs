import http from 'node:http';
import https from 'node:https';
const allowed = host => ['127.0.0.1','localhost','::1','[::1]'].includes(host);
const validate = input => {
  const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input?.hostname || input?.host;
  if (!allowed(host)) throw new Error('INBOX_TEST_EXTERNAL_NETWORK_DENIED');
};
for (const module of [http,https]) for (const key of ['request','get']) {
  const original=module[key]; module[key]=function(input,...args){validate(input);return original.call(this,input,...args);};
}
const originalFetch=globalThis.fetch;
globalThis.fetch=function(input,...args){validate(input instanceof Request?input.url:input);return originalFetch(input,...args);};
