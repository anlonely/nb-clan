import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
export class CandidateError extends Error { constructor(code, status=503) { super(code); this.errorCode=code; this.status=status; } }
export const need=(yes,code,status)=>{if(!yes)throw new CandidateError(code,status);};
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function candidateConfig(input) {
  need(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(k=>['dataDirectory','bindHost','port','intervalMs','shutdownGraceMs'].includes(k)),'CANDIDATE_CONFIG_INVALID',422);
  const {dataDirectory,bindHost='127.0.0.1',port,intervalMs=60000,shutdownGraceMs=15000}=input;
  need(typeof dataDirectory==='string' && path.isAbsolute(dataDirectory) && path.normalize(dataDirectory)===dataDirectory && /^nb-v2-candidate-[A-Za-z0-9_-]{1,64}$/.test(path.basename(dataDirectory)),'CANDIDATE_DIRECTORY_REQUIRED',422);
  need(bindHost==='127.0.0.1' && Number.isInteger(port) && port>=0 && port<=65535,'CANDIDATE_LOOPBACK_REQUIRED',422);
  need(Number.isInteger(intervalMs)&&intervalMs>=1000&&intervalMs<=60000&&Number.isInteger(shutdownGraceMs)&&shutdownGraceMs>=1000&&shutdownGraceMs<=60000,'CANDIDATE_LIMIT_INVALID',422);
  return Object.freeze({dataDirectory,bindHost,port,intervalMs,shutdownGraceMs});
}
export const paths=c=>({database:path.join(c.dataDirectory,'nb-clan.sqlite'),control:path.join(c.dataDirectory,'.candidate'),marker:path.join(c.dataDirectory,'.candidate','owner.json'),managed:path.join(c.dataDirectory,'managed')});
export function candidateEnvironment(input,{searchPath='/usr/bin:/bin',origin}={}) {
  const c=candidateConfig(input); return {PATH:searchPath,...(process.platform==='darwin'?{__CF_USER_TEXT_ENCODING:`0x${process.getuid().toString(16)}:0x0:0x0`}:{}),LANG:'en_US.UTF-8',TZ:'Asia/Shanghai',NODE_ENV:'development',
    NB_DATA_DIR:c.dataDirectory,NB_SQLITE_FILE:paths(c).database,NB_STORAGE_MODE:'sqlite-primary',NB_V2_IDENTITY_ENABLED:'1',NB_OWNER_PASSWORD_LOGIN:'1',
    NB_DISABLE_BACKGROUND_JOBS:'1',NB_DISABLE_DATA_BACKUP:'1',NB_DISABLE_EXTERNAL_VITAL:'1',NB_DISABLE_EXTERNAL_ATLAS:'1',
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS:'0',NB_V2_PUBLIC_ORIGIN:origin||`http://127.0.0.1:${c.port||1}`};
}
export function assertEnvironment(c,{origin,initializing=false}={}) {
  const expected=candidateEnvironment(c,{searchPath:process.env.PATH,origin});
  const allowed=new Set([...Object.keys(expected),...(initializing?['NB_ROOT_PASSWORD']:[])]);
  need(Object.keys(process.env).every(k=>allowed.has(k)),'CANDIDATE_FRESH_PROCESS_REQUIRED');
  for(const [key,value] of Object.entries(expected))need(process.env[key]===value,'CANDIDATE_ENVIRONMENT_MISMATCH');
}
export async function noSymlinks(p) {
  let cursor=path.parse(p).root;
  for(const segment of p.slice(cursor.length).split(path.sep).filter(Boolean)) {cursor=path.join(cursor,segment);const s=await fs.lstat(cursor);need(!s.isSymbolicLink(),'CANDIDATE_SYMLINK_FORBIDDEN',409);}
}
export async function checkDirectory(c) {
  const p=paths(c);await noSymlinks(c.dataDirectory);const dir=await fs.stat(c.dataDirectory);
  need(dir.isDirectory()&&dir.uid===process.getuid()&&(dir.mode&0o077)===0,'CANDIDATE_DIRECTORY_NOT_PRIVATE',409);
  for(const directory of [p.control,p.managed]){await noSymlinks(directory);const s=await fs.stat(directory);need(s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0,'CANDIDATE_DIRECTORY_NOT_PRIVATE',409);}
  await noSymlinks(p.marker);const stat=await fs.stat(p.marker);
  need(stat.isFile()&&stat.uid===process.getuid()&&(stat.mode&0o077)===0&&stat.size<=4096,'CANDIDATE_MARKER_INVALID',409);
  const marker=JSON.parse(await fs.readFile(p.marker,'utf8'));
  need(marker.kind==='nb-clan-v2-candidate'&&marker.version===1&&marker.directory===c.dataDirectory&&/^[a-f0-9-]{36}$/.test(marker.id),'CANDIDATE_MARKER_INVALID',409);
  return marker;
}
export async function createDirectory(c) {
  await noSymlinks(path.dirname(c.dataDirectory));
  await fs.mkdir(c.dataDirectory,{mode:0o700});const p=paths(c);
  await fs.mkdir(p.control,{mode:0o700});await fs.mkdir(p.managed,{mode:0o700});
  const marker={kind:'nb-clan-v2-candidate',version:1,id:randomUUID(),directory:c.dataDirectory,createdAt:new Date().toISOString()};
  await fs.writeFile(p.marker,JSON.stringify(marker)+'\n',{mode:0o600,flag:'wx'});return marker;
}
export async function checkDatabase(c) {
  await checkDirectory(c);const p=paths(c);await noSymlinks(p.database);const s=await fs.stat(p.database);
  need(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=512*1024*1024,'CANDIDATE_DATABASE_INVALID',409);
  for(const suffix of ['-wal','-shm','-journal']){try{const sidecar=p.database+suffix;await noSymlinks(sidecar);const st=await fs.stat(sidecar);need(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0,'CANDIDATE_DATABASE_INVALID',409);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return p.database;
}
/** No automatic stale-lock takeover: another process may still own live work. */
export async function acquireCandidateLease(c){
  await checkDirectory(c);const file=path.join(paths(c).control,'operation.lock'),token=randomUUID();
  try{await fs.writeFile(file,JSON.stringify({token,pid:process.pid,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});}
  catch(e){if(e.code==='EEXIST')throw new CandidateError('CANDIDATE_IN_USE',409);throw e;}
  let released=false;
  return async()=>{if(released)return;await noSymlinks(file);const stat=await fs.stat(file);
    need(stat.isFile()&&stat.size<=4096&&JSON.parse(await fs.readFile(file,'utf8')).token===token,'CANDIDATE_LOCK_CHANGED',409);
    await fs.unlink(file);released=true;
  };
}
