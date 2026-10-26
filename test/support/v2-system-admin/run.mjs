import {mkdtemp,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const base=path.join(root,'test/support/v2-system-admin/.runs');await mkdir(base,{recursive:true});const runDir=await mkdtemp(path.join(base,'run-'));
const env={PATH:process.env.PATH||'/usr/bin:/bin',LANG:'en_US.UTF-8',TZ:'Asia/Shanghai',NODE_ENV:'production',
 NB_DISABLE_BACKGROUND_JOBS:'1',NB_V2_IDENTITY_ENABLED:'1',G07_SYSTEM_RUN:runDir,G07_SYSTEM_MODE:process.argv.includes('--verify')?'verify':'serve',G07_SYSTEM_HOST:process.argv.includes('--localhost')?'localhost':'127.0.0.1',
 NODE_OPTIONS:`--import=${path.join(root,'test/support/v2-baseline/loopback-only.mjs')}`,
 ...(process.platform==='darwin'?{__CF_USER_TEXT_ENCODING:`0x${process.getuid().toString(16)}:0x0:0x0`}:{})};
const child=spawn(process.execPath,[path.join(root,'test/support/v2-system-admin/runtime.mjs')],{cwd:root,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??1));
