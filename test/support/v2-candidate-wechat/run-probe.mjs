import '../results.mjs';
import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {candidateConfig,candidateEnvironment} from '../../../server/v2/candidate-host/config.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),tree=root,mode=process.argv[2]||'mini-media';
fs.mkdirSync(path.join(root,'test/support/v2-candidate-wechat/.runtime'),{recursive:true});
const config=candidateConfig({dataDirectory:path.join(root,'test/support/v2-candidate-wechat/.runtime/nb-v2-candidate-'+randomUUID()),port:0});
const child=spawn(process.execPath,['--import',path.join(tree,'test/support/v2-stats/resolve.mjs'),path.join(tree,'test/support/v2-candidate-wechat',mode.startsWith('migration')?'migration-probe.mjs':'probe.mjs'),JSON.stringify(config),mode],{cwd:tree,env:candidateEnvironment(config,{searchPath:process.env.PATH}),stdio:['ignore','pipe','pipe']});
const timer=setTimeout(()=>child.kill('SIGKILL'),45000),file=fs.createWriteStream(path.join(root,'output/test-results/g07-candidate-wechat',mode+'-verification.json'));
child.stdout.pipe(file);child.stderr.pipe(process.stderr);process.exitCode=await new Promise((r,j)=>{child.once('error',j);child.once('exit',code=>{clearTimeout(timer);r(code??1);});});
