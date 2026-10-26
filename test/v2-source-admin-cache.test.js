import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const exec = promisify(execFile);
test('isolated process verifies original settings-store reader and original patchStoreCache recovery', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'g07-source-cache-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const result=await exec(process.execPath,['--import','./test/support/v2-stats/resolve.mjs','test/support/v2-source-admin/cache-child.mjs',dir],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',TZ:'Asia/Shanghai',NB_DISABLE_BACKGROUND_JOBS:'1'},timeout:20000});
  assert.ok(result.stdout.includes('"originalStoreCache":true'));assert.ok(result.stdout.includes('"replayRepaired":true'));
});
