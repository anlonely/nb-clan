import '../results.mjs';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readdir} from 'node:fs/promises';
import {root,environment} from './config.mjs';
const base=`${root}/test/support/v2-platform-admin/.runtime`;await mkdir(base,{recursive:true,mode:0o700});const dir=await mkdtemp(`${base}/verify-`),env=environment(dir,0);
const own=(await readdir(`${root}/test`)).filter(n=>/^v2-platform-admin.*\.test\.js$/.test(n)).map(n=>`test/${n}`);
const regression=['test/v2-identity.test.js','test/v2-identity-http.test.js','test/v2-scheduling.test.js','test/v2-scheduling-adapters.test.js','test/v2-scheduling-eligibility.test.js','test/v2-notification-platforms-transport.test.js','test/v2-notification-platforms-native-callbacks.test.js','test/v2-query-client.test.js'];
async function run(args,file){let output='';const child=spawn(process.execPath,args,{cwd:root,env:{...env,...(file==='build.log'?{NODE_ENV:'production'}:{})},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);const code=await new Promise(r=>child.on('exit',r));await writeFile(`${root}/output/test-results/g07-platforms/${file}`,output);console.log(JSON.stringify({file,exitCode:code}));if(code!==0)throw new Error(`Verification failed: ${file}`);return {command:[process.execPath,...args],exitCode:code};}
const tests=await run(['--test','--test-reporter=tap',...own],'tests.tap'),regress=await run(['--test','--test-reporter=tap',...regression],'regression.tap'),build=await run(['test/support/v2-platform-admin/build.mjs'],'build.log');
await writeFile(`${root}/output/test-results/g07-platforms/verification.json`,JSON.stringify({at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,environmentKeys:Object.keys(env),loopbackOnly:true,productionCredentials:false,backgroundJobs:false,buildNodeEnv:'production',tests,regress,build},null,2));
