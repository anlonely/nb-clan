import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
await mkdir(path.join(root,'work/g06-c'),{recursive:true});
const runDir=await mkdtemp(path.join(root,'work/g06-c/verification-'));
// Child processes inherit only this whitelist, never .env/cloud/proxy/credentials.
const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',TZ:'Asia/Shanghai',NODE_ENV:'test',
  NB_DISABLE_BACKGROUND_JOBS:'1',NB_DISABLE_EXTERNAL_VITAL:'1',NB_DISABLE_EXTERNAL_ATLAS:'1',
  NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS:'0',NB_DATA_DIR:path.join(runDir,'unused-data'),
  NB_SQLITE_FILE:path.join(runDir,'unused.sqlite'),NB_V2_PUBLIC_ORIGIN:'http://127.0.0.1:1',
  NODE_OPTIONS:`--import=${path.join(root,'test/support/v2-baseline/loopback-only.mjs')}`};
const groups={platforms:(await readdir(path.join(root,'test'))).filter(n=>/^v2-notification-platforms-.*\.test\.js$/.test(n)).sort().map(n=>`test/${n}`),
  scheduling:(await readdir(path.join(root,'test'))).filter(n=>/^v2-scheduling.*\.test\.js$/.test(n)).sort().map(n=>`test/${n}`),
  identity:['test/v2-identity.test.js']};
const stages=[];
for(const [name,files] of Object.entries(groups)) {
  const result=await new Promise(resolve=>{
    const child=spawn(process.execPath,['--test','--test-reporter=tap',...files],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
    child.on('error',error=>{output+=`${error.code}\n`;});
    child.on('close',(code,signal)=>resolve({code,signal,output}));
  });
  await writeFile(path.join(runDir,`${name}.tap`),result.output);
  stages.push({name,files,exitCode:result.code,signal:result.signal,
    tests:Number(result.output.match(/^# tests (\d+)/m)?.[1]||0),passed:Number(result.output.match(/^# pass (\d+)/m)?.[1]||0),
    failed:Number(result.output.match(/^# fail (\d+)/m)?.[1]||0),sha256:createHash('sha256').update(result.output).digest('hex')});
  console.log(`${name}: ${stages.at(-1).passed}/${stages.at(-1).tests}, exit ${result.code}`);
}
const sourceHashes={};
for(const dir of ['server/v2/notification-platforms','test/support/v2-notification-platforms'])for(const name of await readdir(path.join(root,dir))){
  const file=path.join(dir,name);sourceHashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
}
const manifest={schemaVersion:1,contract:'g06-parallel/1 + addendum-01',runDir,cwd:root,node:process.version,
  passed:stages.every(s=>s.exitCode===0&&s.tests>0&&s.failed===0),stages,sourceHashes,environmentKeys:Object.keys(env).sort(),
  network:'Node loopback-only guard in every child; one ephemeral 127.0.0.1 HTTP server; no platform network.',
  databases:'Each callback fixture creates a new SQLite under work/g06-c and removes it after closing.',
  credentials:'Generated ephemeral local signing material only; no environment token or production files.',
  browser:'Not applicable to platform-only module; full G06 real browser integration remains coordinator-owned.',
  build:'No frontend changes; Node public-entry import and executable tests validate this module. Overall app build remains integration-owned.',
  fullApiRouter:'Not exercised: C owns no shared route mutations. Raw HTTP harness verifies its exact callback contract only.',
  realExternalAcceptance:false};
await writeFile(path.join(runDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({runDir,passed:manifest.passed,stages:stages.map(({name,tests,passed,failed})=>({name,tests,passed,failed}))},null,2));
process.exitCode=manifest.passed?0:1;
