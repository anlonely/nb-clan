import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export function environment(dir,port=4337){assert.equal(path.dirname(dir),path.join(root,'test/support/v2-sync-center/.runtime'));return {PATH:process.env.PATH||'/usr/bin:/bin',...(process.platform==='darwin'?{__CF_USER_TEXT_ENCODING:`0x${process.getuid().toString(16)}:0x0:0x0`}:{}),LANG:'en_US.UTF-8',TZ:'Asia/Shanghai',NODE_ENV:'development',NB_DISABLE_BACKGROUND_JOBS:'1',NB_DISABLE_EXTERNAL_VITAL:'1',NB_DISABLE_EXTERNAL_ATLAS:'1',NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS:'0',G07_SYNC_DIR:dir,G07_SYNC_PORT:String(port),NODE_OPTIONS:`--import=${root}/test/support/v2-baseline/loopback-only.mjs`};}
export function validate(){const expected=environment(process.env.G07_SYNC_DIR,Number(process.env.G07_SYNC_PORT));assert.deepEqual(Object.keys(process.env).sort(),Object.keys(expected).sort());for(const k of Object.keys(expected))assert.equal(process.env[k],expected[k]);}
