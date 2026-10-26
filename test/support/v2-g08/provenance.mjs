import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export async function sourceProvenance(){
 const files=[];async function scan(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=directory+'/'+entry.name;if(entry.isDirectory())await scan(file);else if(entry.isFile()&&/\.(?:js|mjs|jsx|css)$/.test(file))files.push({path:file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});}}
 for(const directory of ['server/v2','src/v2','test/support/v2-g08'])await scan(directory);
 files.sort((a,b)=>a.path.localeCompare(b.path));
 return {at:new Date().toISOString(),cwd:process.cwd(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files,productSha256:createHash('sha256').update(JSON.stringify(files.filter(f=>!f.path.startsWith('scripts/')))).digest('hex'),sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
