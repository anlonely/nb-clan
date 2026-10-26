#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitFiles, isPublicPath, scanFiles, printReport } from './check-public-release.mjs';

const args = process.argv.slice(2);
const root = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : '.');
const outputArg = args[args.indexOf('--output') + 1];
if (!args.includes('--output') || !outputArg) {
  console.error('Usage: node scripts/release-public.mjs --output <new-directory> [--include-dist] [--root <repository>]');
  process.exit(2);
}
const output = path.resolve(outputArg);
let staging;
try {
  if (output === root || root.startsWith(output + path.sep)) throw new Error('invalid-output');
  try { await fs.lstat(output); throw new Error('output-exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let files = gitFiles(root, true).filter(file => isPublicPath(file, args.includes('--include-dist')));
  if (args.includes('--include-dist')) {
    async function walk(directory) {
      const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
      for (const entry of entries) {
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(file);
        else if (isPublicPath(file, true)) files.push(file);
      }
    }
    await walk('dist');
    files = [...new Set(files)].sort();
  }
  const report = await scanFiles(root, files);
  printReport(report);
  if (report.findings.length) process.exit(1);
  await fs.mkdir(path.dirname(output), { recursive: true });
  staging = await fs.mkdtemp(path.join(path.dirname(output), '.nb-release-staging-'));
  const manifest = [];
  const hashes = {};
  for (const file of files) {
    const source = path.join(root, file);
    try { if (!(await fs.lstat(source)).isFile()) continue; } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const destination = path.join(staging, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    manifest.push(file);
    hashes[file] = createHash('sha256').update(await fs.readFile(destination)).digest('hex');
  }
  // Check the exported bytes too, so an edit between scanning and copying cannot
  // turn the candidate into an unchecked release.
  const exportedReport = await scanFiles(staging, manifest);
  if (exportedReport.findings.length) { printReport(exportedReport); throw new Error('export-content-changed'); }
  await fs.writeFile(path.join(staging, 'PUBLIC-RELEASE-MANIFEST.json'), JSON.stringify({
    scope: report.scope,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    note: 'Exported from current worktree. This revision may include uncommitted changes. No Git history is included.',
    files: manifest,
    sha256: hashes,
  }, null, 2) + '\n');
  // The staging directory stays private until all exported bytes pass.
  await fs.rename(staging, output);
  staging = undefined;
  console.log(`Exported ${manifest.length} allowlisted files to ${output}`);
} catch (error) {
  console.error(`Release export failed: ${error.code || error.message}`);
  process.exitCode = 2;
} finally {
  if (staging) await fs.rm(staging, { recursive: true, force: true });
}
