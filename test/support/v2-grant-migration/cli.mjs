import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planGrantMigration, applyGrantMigration } from '../../../server/v2/identity/grant-migration.js';

const { values } = parseArgs({ options: {
  db: { type: 'string' }, mode: { type: 'string', default: 'dry-run' },
  'identity-plan': { type: 'string' }, plan: { type: 'string' }, output: { type: 'string' },
  'expected-digest': { type: 'string' }, operator: { type: 'string' }
} });
if (!values.db || !['dry-run', 'apply'].includes(values.mode)) throw new Error('--db and --mode dry-run|apply required');
const path = realpathSync(values.db);
const identityPlan = values['identity-plan'] ? JSON.parse(readFileSync(values['identity-plan'], 'utf8')) : undefined;
const inputPlan = values.plan ? JSON.parse(readFileSync(values.plan, 'utf8')) : undefined;
if (values.mode === 'apply' && (!inputPlan || !values.operator || !values['expected-digest']))
  throw new Error('apply requires --plan, --operator, and --expected-digest from the reviewed dry-run');
if (values.output && [path, values.plan && resolve(values.plan), values['identity-plan'] && resolve(values['identity-plan'])].includes(resolve(values.output)))
  throw new Error('Output must be a new artifact, separate from DB and input plans');
const db = new DatabaseSync(path, { readOnly: values.mode === 'dry-run' });
try {
  const repo = new IdentityRepository(db);
  const result = values.mode === 'dry-run' ? planGrantMigration(repo, { identityPlan }) :
    applyGrantMigration(repo, inputPlan, { identityPlan, operatorId: values.operator, expectedDigest: values['expected-digest'] });
  const rendered = JSON.stringify(result, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, rendered, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(rendered);
} finally { db.close(); }
