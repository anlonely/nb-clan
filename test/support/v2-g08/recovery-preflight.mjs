import '../results.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startBackend} from './host.mjs';
import {recoveryProof} from './recovery-proof.mjs';
const directory=process.argv[2],ev=path.resolve('output/test-results/g08'),result={directory};let backend;
try{backend=await startBackend({directory,resume:true,log:ev+'/recovery-preflight-backend.log'});result.proof=await recoveryProof(backend);result.success=true;}
catch(e){result.error=e.stack;process.exitCode=1;console.error(e.stack);}
finally{result.shutdown=await backend?.stop().catch(e=>({error:e.stack}));await fs.writeFile(ev+'/recovery-preflight.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({success:result.success,error:result.error}));}
