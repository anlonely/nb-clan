import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function verify({origin,runDir,f}) {
 const root=process.cwd(),testFiles=['test/v2-system-admin.test.js','test/v2-system-admin-http.test.js','test/v2-identity.test.js','test/v2-identity-http.test.js'];
 let output='';const code=await new Promise(resolve=>{const p=spawn(process.execPath,['--test',...testFiles],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
 p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('exit',resolve);});
 await writeFile(path.join(runDir,'tests.log'),output);assert.equal(code,0,output.slice(-5000));
 const login=await fetch(origin+'/__fixture/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({account:'root'})});assert.equal(login.status,200);
 const cookies=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),me=await fetch(origin+'/api/v2/auth/me',{headers:{cookie:cookies}}).then(r=>r.json());
 const headers={cookie:cookies,Origin:origin,'X-CSRF-Token':me.data.csrfToken,'Content-Type':'application/json'};
 const request=async(action,input,target='')=>{const r=await fetch(origin+'/api/v2/system-admin/commands/'+action,{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({input,target})});assert.equal(r.status,200);return(await r.json()).data;};
 const brand=await request('brand.reset',{expectedRevision:0}),backup=await request('storage.backup',{expectedRevision:0}),restore=await request('storage.restore',{expectedRevision:1,artifactRevision:1},backup.current.id);
 const candidate=f.service.repo.artifact(restore.current.id),restored=new DatabaseSync(f.storage.candidatePath(candidate),{readOnly:true});
 assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');const recordCount=restored.prepare('SELECT count(*) n FROM json_records').get().n;restored.close();
 const assets=[];for(const file of await readdir(path.join(runDir,'dist/assets'))){const b=await readFile(path.join(runDir,'dist/assets',file));assets.push({file,bytes:b.length,sha256:sha(b)});}
 const report={schemaVersion:1,completedAt:new Date().toISOString(),baseHead:'01a9fbb57e1b9a7d6ab1d114e22cc0f92932d668',
 inputManifestSha256:'7425deed0cc35f5fbc84963557a9a206461c74d2a9ab707aca713e69e54ed0c9',node:process.version,os:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,memoryBytes:os.totalmem(),
 runtime:{origin,runDir,network:'loopback only',environment:'explicit allowlist',database:'independent WAL SQLite',realExternalAcceptance:false},testFiles,testExitCode:code,lockfileSha256:sha(await readFile('package-lock.json')),assets,
 recovery:{backup:backup.current,restore:restore.current,restoredRecords:recordCount,liveDatabaseReplaced:false},cacheEffects:f.counters(),brandRevision:brand.current.revision};
 await writeFile(path.join(runDir,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({verified:true,runDir,testExitCode:code}));
}
