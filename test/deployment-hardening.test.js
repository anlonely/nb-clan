import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('container and deploy definitions retain the production hardening contract', async () => {
  const [dockerfile, prebuilt, compose, prebuiltCompose, deploy, dockerignore] = await Promise.all([
    readFile('Dockerfile', 'utf8'),
    readFile('Dockerfile.prebuilt', 'utf8'),
    readFile('docker-compose.yml', 'utf8'),
    readFile('docker-compose.prebuilt.yml', 'utf8'),
    readFile('scripts/deploy-prebuilt-production.sh', 'utf8'),
    readFile('.dockerignore', 'utf8')
  ]);

  for (const contents of [dockerfile, prebuilt]) {
    assert.match(contents, /node:22\.23\.1-alpine3\.24@sha256:[a-f0-9]{64}/);
    assert.match(contents, /USER \$\{APP_UID\}:\$\{APP_GID\}/);
    assert.match(contents, /ENV NB_TRUST_PROXY=0/);
    assert.match(contents, /ENV NB_MANAGED_EXPORT_CONTAINER_MODE=1/);
    assert.doesNotMatch(contents, /ENV NB_CHROMIUM_DISABLE_SANDBOX=/);
    assert.match(contents, /HEALTHCHECK[\s\S]*\/api\/readyz/);
  }
  assert.match(prebuilt, /COPY --chown=.* dist \.\/dist/);

  assert.doesNotMatch(compose, /network_mode:\s*host/);
  assert.match(compose, /127\.0\.0\.1.*8787.*8787/);
  assert.match(compose, /APP_UID:\s*"\$\{NB_CONTAINER_UID:-10001\}"/);
  assert.match(compose, /APP_GID:\s*"\$\{NB_CONTAINER_GID:-10001\}"/);
  assert.match(compose, /user:\s*"\$\{NB_CONTAINER_UID:-10001\}:\$\{NB_CONTAINER_GID:-10001\}"/);
  assert.match(compose, /NB_TRUST_PROXY=\$\{NB_TRUST_PROXY:-0\}/);
  assert.match(prebuiltCompose, /APP_UID:\s*"\$\{NB_CONTAINER_UID:-10001\}"/);
  assert.match(prebuiltCompose, /APP_GID:\s*"\$\{NB_CONTAINER_GID:-10001\}"/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:[\s\S]*- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cpus:/);
  assert.match(compose, /mem_limit:/);
  assert.match(compose, /pids_limit:/);
  assert.match(compose, /stop_grace_period:/);

  assert.match(deploy, /wait_for_readiness 'candidate container'/);
  assert.match(deploy, /rollback_on_error/);
  assert.match(deploy, /nb-clan-member-system:rollback/);
  assert.match(deploy, /deployment remains failed for operator visibility/);
  assert.match(deploy, /--build-arg "APP_UID=\$\{APP_UID\}"/);
  assert.match(deploy, /--build-arg "APP_GID=\$\{APP_GID\}"/);
  assert.match(deploy, /NB_CONTAINER_UID="\$\{APP_UID\}"/);
  assert.match(deploy, /old_container_user/);
  await execFileAsync('bash', ['-n', path.resolve('scripts/deploy-prebuilt-production.sh')]);

  assert.match(dockerignore, /^\*\*\/\.env$/m);
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/m);
  assert.match(dockerignore, /^\*\*\/\*\.pem$/m);
  assert.match(dockerignore, /^\*\*\/\*\.key$/m);
  assert.doesNotMatch(dockerignore, /^dist$/m);
});
