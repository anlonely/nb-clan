import '../results.mjs';
// Execute the unchanged risk assertions with output/runtime paths isolated from the prior delivery.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const input=new URL('../v2-risk-collector/run.mjs',import.meta.url),output=new URL('./.runtime-risk-run.mjs',import.meta.url);
let source=await readFile(input,'utf8');
for(const [before,after] of [['test/support/v2-risk-collector/.runtime','test/support/v2-provider-projection/.runtime-risk'],['output/test-results/g07-risk-collector/runtime-report.json','output/test-results/g07-provider-projection/risk-regression/runtime-report.json']]){assert.equal(source.split(before).length,2);source=source.replace(before,after);}
await writeFile(output,source,{flag:'wx'});
try{const child=spawn(process.execPath,[fileURLToPath(output)],{stdio:'inherit',env:process.env});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0);}finally{await rm(output);}
