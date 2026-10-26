import '../results.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture, httpFixture, steam, secrets } from './fixture.mjs';
const f = fixture(), h = await httpFixture(f), evidence = new URL('../../../output/test-results/g07-public-query/', import.meta.url);
const report = { isolated: true, authentication: 'real G03 cookie/CSRF', externalAdapters: false, exports: [] };
const sha = value => createHash('sha256').update(value).digest('hex');
const members = () => sha(JSON.stringify(f.db.prepare("SELECT * FROM json_records WHERE collection='members' ORDER BY id").all()));
const beforeMembers = members(), headers = h.headers('query_only');
const request = (path, body, id) => fetch(h.origin + '/api/v2/stats/' + path, { headers: { ...headers, 'Idempotency-Key': id || 'public-query-probe' },
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
const clean = value => { for (const secret of secrets) assert.ok(!String(value).includes(secret), secret); };
try {
  const before = f.changes();
  report.capabilities = f.service.queryCapabilities(f.actor('query_only'), { steamInput: steam });
  report.publicResult = f.service.memberQuery(steam, { actor: f.actor('query_only') });
  assert.equal(f.changes(), before); report.directProjectionAndCapabilitiesReadOnly = true;
  const response = await request('queries', { sourceId: 'member', steamInput: steam }); assert.equal(response.status, 200);
  const query = (await response.json()).data; await f.service.runJob(query.jobId);
  const result = await request('jobs/' + query.jobId), output = await result.json();
  clean(JSON.stringify(output));
  await writeFile(new URL('http-query-result.json', evidence), JSON.stringify(output, null, 2) + '\n');
  for (const format of ['json', 'html', 'csv']) {
    const created = await request('exports', { queryJobId: query.jobId, format, language: 'zh', timeZone: 'Asia/Shanghai' }, 'probe-export-' + format);
    assert.equal(created.status, 200); const exportId = (await created.json()).data.jobId; await f.service.runJob(exportId);
    const descriptor = (await (await request('jobs/' + exportId)).json()).data;
    const download = await request(`jobs/${exportId}/file`), bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(download.status, 200); clean(bytes.toString()); assert.equal(sha(bytes), descriptor.result.sha256);
    assert.equal(descriptor.result.base64, undefined);
    await writeFile(new URL('public-query-export.' + format, evidence), bytes);
    report.exports.push({ format, status: download.status, bytes: bytes.length, sha256: sha(bytes),
      contentType: download.headers.get('content-type'), contentDisposition: download.headers.get('content-disposition'),
      cacheControl: download.headers.get('cache-control'), contentSecurityPolicy: download.headers.get('content-security-policy'),
      projectionVersion: descriptor.result.queryProjectionVersion, projectionHash: descriptor.result.queryProjectionHash });
  }
  report.memberFactsBeforeSha256 = beforeMembers; report.memberFactsAfterSha256 = members();
  assert.equal(beforeMembers, report.memberFactsAfterSha256); report.memberProviderCalls = f.calls.length; assert.equal(f.calls.length, 0);
  report.ok = true;
} finally { await h.close(); f.db.close(); }
await writeFile(new URL('probe-report.json', evidence), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, exports: report.exports.map(({ format, bytes, sha256 }) => ({ format, bytes, sha256 })) }, null, 2));
