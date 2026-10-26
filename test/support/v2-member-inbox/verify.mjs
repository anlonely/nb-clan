import '../results.mjs';
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const env=Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const own=readdirSync(resolve(root,'test')).filter(n=>/^v2-member-inbox.*\.test\.js$/.test(n)).map(n=>'test/'+n);
const regression=readdirSync(resolve(root,'test')).filter(n=>/^v2-identity.*\.test\.js$/.test(n)||['v2-platform-admin.test.js','v2-member-space.test.js'].includes(n)).map(n=>'test/'+n);
const results=[];
for(const [name,files] of [['tests',own],['regression',regression]]) {
  const r=spawnSync(process.execPath,['--import',resolve(root,'test/support/v2-member-inbox/loopback-only.mjs'),'--test','--test-reporter=tap',...files],
    {cwd:root,env,encoding:'utf8',timeout:60000});
  writeFileSync(resolve(root,`output/test-results/g07-member-inbox/${name}.tap`),r.stdout+r.stderr);
  const passed=Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1]||0),failed=Number(/^# fail (\d+)$/m.exec(r.stdout)?.[1]||0);
  results.push({name,exitCode:r.status,passed,failed,files});
  if(r.error||r.status!==0){process.stderr.write(r.stdout+r.stderr);throw r.error||new Error(name+' failed');}
}
writeFileSync(resolve(root,'output/test-results/g07-member-inbox/verification.json'),JSON.stringify({
  node:process.version,network:'loopback-only HTTP/fetch test guard',env:'explicit allowlist; no project .env',results,
  database:'fresh per fixture temporary disk SQLite; removed after successful fixture tests',http:'random 127.0.0.1; all listeners closed'},null,2)+'\n');
console.log(JSON.stringify(results.map(({name,passed,failed})=>({name,passed,failed})),null,2));
