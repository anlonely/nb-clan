// Verification only: fail before any default data/.env access or non-loopback I/O.
import '../v2-baseline/loopback-only.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
export const observations={candidateAccesses:0,forbiddenAttempts:0,externalNetworkAttempts:0};
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){
  try{return connect.apply(this,args);}catch(e){if(e.code==='G01_EGRESS_BLOCKED')observations.externalNetworkAttempts++;throw e;}
};
const repository=fileURLToPath(new URL('../../../',import.meta.url));
function inspect(value){
  if(typeof value!=='string'&&!(value instanceof URL)&&!Buffer.isBuffer(value))return;
  const p=path.resolve(value instanceof URL?fileURLToPath(value):String(value));
  if(p.startsWith(process.env.NB_DATA_DIR+path.sep)||p===process.env.NB_DATA_DIR)observations.candidateAccesses++;
  const roots=[path.join(repository,'data'),'/isolated-forbidden-production-data'];
  if(/^\.env(?:\.|$)/.test(path.basename(p))||roots.some(r=>p===r||p.startsWith(r+path.sep))){observations.forbiddenAttempts++;throw Error('CANDIDATE_TEST_FORBIDDEN_DEFAULT_IO');}
}
for(const target of [fs,fs.promises])for(const name of ['readFile','readFileSync','writeFile','writeFileSync','open','openSync','access','accessSync','existsSync','stat','statSync','lstat','lstatSync','readdir','readdirSync','appendFile','appendFileSync']){
  if(typeof target[name]!=='function')continue;const original=target[name];target[name]=function(p,...args){inspect(p);return original.call(this,p,...args);};
}
syncBuiltinESMExports();
