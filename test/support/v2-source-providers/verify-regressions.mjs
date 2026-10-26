import '../results.mjs';
// Run protected risk harness with only this goal's runtime/report paths redirected.
import { readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const original=await readFile(new URL('../v2-risk-collector/run.mjs',import.meta.url),'utf8');
const redirected=original.replace('test/support/v2-risk-collector/.runtime','test/support/v2-source-providers/.runtime-risk')
 .replace('output/test-results/g07-risk-collector/runtime-report.json','output/test-results/g07-source-providers/risk-regression.json');
assert.notEqual(original,redirected);
const entry=new URL(`.risk-check-${randomUUID()}.mjs`,import.meta.url);await writeFile(entry,redirected);
try {
 const child=spawn(process.execPath,[fileURLToPath(entry)],{cwd:root,stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0);
 const target=new URL('../../../output/test-results/g07-source-providers/risk-regression.json',import.meta.url);const report=JSON.parse(await readFile(target));
 report.harness={originalSha256:createHash('sha256').update(original).digest('hex'),changes:'only own runtime/report paths',oldGoalArtifactModified:false};await writeFile(target,JSON.stringify(report,null,2)+'\n');await chmod(target,0o644);
}finally{await unlink(entry);}
