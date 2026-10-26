import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile, readFile, lstat } from 'node:fs/promises';
const fail = (errorCode, status = 422) => { throw Object.assign(new Error(errorCode), { errorCode, status }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);

/** Only the isolated runtime calls this helper; no product route imports it. */
export async function saveBrowserEvidence(runDir, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name','base64','json'].includes(key))) fail('EVIDENCE_INVALID');
  if (typeof body.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(?:png|json)$/.test(body.name)) fail('EVIDENCE_NAME_INVALID');
  const isBase64 = Object.hasOwn(body,'base64'), isJson = Object.hasOwn(body,'json');
  if (isBase64 === isJson) fail('EVIDENCE_PAYLOAD_INVALID');
  let bytes;
  if (isBase64) {
    if (typeof body.base64 !== 'string' || !body.base64.length || body.base64.length > 3 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) fail('EVIDENCE_PAYLOAD_INVALID');
    bytes = Buffer.from(body.base64,'base64');
    if (bytes.toString('base64') !== body.base64) fail('EVIDENCE_PAYLOAD_INVALID');
  } else {
    if (!body.name.endsWith('.json')) fail('EVIDENCE_PAYLOAD_INVALID');
    try { bytes = Buffer.from(JSON.stringify(body.json,null,2)); } catch { fail('EVIDENCE_PAYLOAD_INVALID'); }
  }
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) fail('EVIDENCE_TOO_LARGE',413);
  if (body.name.endsWith('.png') && !bytes.subarray(0,8).equals(pngSignature)) fail('EVIDENCE_PNG_INVALID');
  if (body.name.endsWith('.json')) { try { JSON.parse(bytes.toString('utf8')); } catch { fail('EVIDENCE_JSON_INVALID'); } }
  const directory = path.join(runDir,'browser-evidence');
  await mkdir(directory,{recursive:true,mode:0o700});
  if (await realpath(directory) !== directory) fail('EVIDENCE_DIRECTORY_INVALID');
  const file = path.join(directory,body.name), sha256 = hash(bytes);
  let replayed = false;
  try { await writeFile(file,bytes,{flag:'wx',mode:0o600}); }
  catch(error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await lstat(file)).isFile() || hash(await readFile(file)) !== sha256) fail('EVIDENCE_NAME_CONFLICT',409);
    replayed = true;
  }
  return { file, bytes:bytes.length, sha256, replayed };
}
