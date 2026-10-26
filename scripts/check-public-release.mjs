#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Explicit release surface. Historical evidence, prototypes, local state and arbitrary
// root files do not become public merely because somebody committed them.
export const publicRoots = ['src/', 'server/', 'shared/', 'public/', 'test/', 'deploy/nginx/', 'wechat-miniprogram/miniprogram/', 'wechat-miniprogram/test/', 'wechat-miniprogram/scripts/'];
export const publicFiles = new Set([
  '.gitignore', '.dockerignore', '.gitleaks.toml',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/pull_request_template.md', '.github/dependabot.yml', '.env.example', '.nvmrc', '.node-version',
  'Dockerfile', 'Dockerfile.prebuilt', 'Dockerfile.prebuilt.dockerignore',
  'docker-compose.yml', 'docker-compose.prebuilt.yml', 'docker-compose.production.yml', 'docker-compose.proxy.yml', 'docker-compose.bind-data.yml',
  'package.json', 'package-lock.json', 'index.html', 'vite.config.js',
  'README.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'scripts/test.mjs', 'scripts/init-admin.js', 'scripts/setup.mjs', 'scripts/start.mjs', 'scripts/doctor.mjs', 'scripts/runtime-config.mjs',
  'scripts/sqlite-backup.js', 'scripts/sqlite-index-check.js', 'scripts/sqlite-integrity-check.js',
  'scripts/sqlite-migrate-store.js', 'scripts/sqlite-verify-store.js',
  'scripts/adopt-platform-card.mjs', 'scripts/battlemetrics-player-hours.js', 'scripts/member-profile-sync-child.mjs', 'scripts/sqlite-perf-watch-production.sh',
  'wechat-miniprogram/package.json', 'wechat-miniprogram/README.md', 'wechat-miniprogram/project.config.json', 'wechat-miniprogram/.gitignore',
  'scripts/check-public-release.mjs', 'scripts/release-public.mjs', 'scripts/deploy-prebuilt-production.sh',
  'docs/INSTALLATION.md', 'docs/CONFIGURATION.md', 'docs/ARCHITECTURE.md', 'docs/INTEGRATIONS.md', 'docs/OPERATIONS.md', 'docs/OPEN_SOURCE_RELEASE.md',
]);
const forbiddenSegment = /^(?:\.git|node_modules|data|work|output|outputs|coverage|\.release-artifacts|\.runtime|\.baseline[^/]*|\.candidate|\.runs|\.cache|\.secrets|secrets|credentials|\.auth|\.ssh|\.playwright[^/]*|browser-(?:profile|state)[^/]*)$/i;
export function isSensitivePath(file) {
  const parts = file.split('/');
  return parts.some(part => forbiddenSegment.test(part))
    || /(?:^|\/)(?:project\.private\.config\.json|root-credentials\.txt|credentials\.(?:json|txt)|cookies[^/]*\.json|cookies\.txt|id_rsa|id_ed25519|storage-?state[^/]*\.json|\.env(?:\..*)?)$/i.test(file) && !/(?:^|\/)\.env\.example$/.test(file)
    || /\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|p12|pfx|bak|log)$/i.test(file);
}
export function isPublicPath(file, includeDist = false) {
  return !isSensitivePath(file) && (publicFiles.has(file)
    || publicRoots.some(root => file.startsWith(root))
    || file.startsWith('scripts/v2-production/') && file.endsWith('.mjs')
    || file.startsWith('.github/workflows/') && /\.ya?ml$/.test(file)
    || includeDist && file.startsWith('dist/'));
}
export function gitFiles(root, includeUntracked = false) {
  const args = ['ls-files', '-z', '--cached'];
  if (includeUntracked) args.push('--others', '--exclude-standard');
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot enumerate Git current files');
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum - count / value.length * Math.log2(count / value.length), 0);
}
export function scanText(file, text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const rules = [
      ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/],
    ];
    for (const [rule, pattern] of rules) if (pattern.test(line)) findings.push({ path: file, line: index + 1, rule });
    for (const match of line.matchAll(/(?:https?|socks5?):\/\/([^\s/:@]+):([^\s/@]{4,})@([^\s/\x22\x27]+)/ig)) {
      const [, , password, host] = match;
      const reservedHost = /^(?:localhost|127\.|\[::1\]|[^:]*\.test(?::|$)|(?:[^:]+\.)?example\.(?:com|net|org)(?::|$))/i.test(host);
      if (!reservedHost && !/^(?:pass(?:word)?|secret|test|fake|example)$/i.test(password)) findings.push({ path: file, line: index + 1, rule: 'url-credentials' });
    }
    const assignment = /(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z_]*|(?:access|refresh|bot)Token|clientSecret)\s*[=:]\s*["']([^"'\s]{32,})["']/ig;
    for (const match of line.matchAll(assignment)) {
      const value = match[1];
      if (!/^(?:\$\{|process\.|example|test|fake|placeholder|replace|your[-_]|<)/i.test(value)
        && !value.includes('${') && /^[A-Za-z0-9_+/.=-]+$/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && (value.match(/[0-9]/g) || []).length >= 3 && entropy(value) >= 3.7) findings.push({ path: file, line: index + 1, rule: 'credential-assignment' });
    }
  }
  return findings;
}
export async function scanFiles(root, files) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    let stat;
    try { stat = await fs.lstat(path.join(root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) { findings.push({ path: file, line: 1, rule: 'symlink' }); continue; }
    if (!stat.isFile()) continue;
    scanned++;
    if (isSensitivePath(file)) findings.push({ path: file, line: 1, rule: 'sensitive-path' });
    const content = await fs.readFile(path.join(root, file));
    // Binary media is included in the manifest but not searched as source text.
    if (!content.includes(0)) findings.push(...scanText(file, content.toString('utf8')));
  }
  return { scope: 'current-files-only; Git history is not scanned', scanned, findings };
}
export function printReport(report) {
  for (const finding of report.findings) console.error(`${finding.path}:${finding.line} [${finding.rule}]`);
  console.log(`Scanned ${report.scanned} current files; ${report.findings.length} findings. Git history was not scanned.`);
}
async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : '.');
  const candidate = args.includes('--candidate');
  const files = gitFiles(root, candidate).filter(file => !candidate || isPublicPath(file));
  const report = await scanFiles(root, files);
  if (args.includes('--json')) {
    const target = path.resolve(args[args.indexOf('--json') + 1]);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  printReport(report);
  process.exitCode = report.findings.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Release check failed: ${error.code || 'invalid-input'}`); process.exitCode = 2; });
}
