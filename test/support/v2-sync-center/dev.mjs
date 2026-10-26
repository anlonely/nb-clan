import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,realpath} from 'node:fs/promises';
import path from 'node:path';
import {root,environment} from './config.mjs';
if(await realpath(process.cwd())!==root)throw new Error('Start from actual G07 worktree');
const base=path.join(root,'test/support/v2-sync-center/.runtime');await mkdir(base,{recursive:true,mode:0o700});if(await realpath(base)!==base)throw new Error('Symlink runtime not allowed');
const dir=await mkdtemp(path.join(base,'run-'));const child=spawn(process.execPath,['test/support/v2-sync-center/runtime.mjs'],{env:environment(dir,Number(process.argv[2]||4337)),stdio:'inherit'});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));child.on('exit',code=>process.exitCode=code||0);
