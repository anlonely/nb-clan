import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {candidateConfig,candidateEnvironment} from '../../../server/v2/candidate-host/config.js';
const [action,dataDirectory,...args]=process.argv.slice(2);
const value=k=>args[args.indexOf(k)+1];
const flags=action==='apply'?['--port','--digest','--operator']:['--port'];
if(!['init','plan','apply','serve'].includes(action)||args.length!==flags.length*2||!flags.every(flag=>args.filter(a=>a===flag).length===1)||args.some((v,i)=>i%2===0?!flags.includes(v):typeof v!=='string'||v.startsWith('--')))throw Error('Usage: launch.mjs init|plan|apply|serve /absolute/nb-v2-candidate-name --port PORT [--digest SHA256 --operator ROOT_ID]');
const config=candidateConfig({dataDirectory,port:Number(value('--port'))});
const root=fileURLToPath(new URL('../../../',import.meta.url));
// Preserve only explicit Node preloads (e.g. the caller's dependency resolver).
// Never inherit NODE_OPTIONS or unrelated execution flags into the candidate.
const preloads=[];
for(let i=0;i<process.execArgv.length;i++){const a=process.execArgv[i];if(a==='--import'&&process.execArgv[i+1])preloads.push(a,process.execArgv[++i]);else if(a.startsWith('--import='))preloads.push(a);}
const child=spawn(process.execPath,[...preloads,path.join(root,'test/support/v2-candidate-host/run.mjs'),action,JSON.stringify(config),...(args.includes('--digest')?[value('--digest'),value('--operator')]:[])],{
  cwd:root,stdio:'inherit',env:candidateEnvironment(config,{searchPath:process.env.PATH})});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
