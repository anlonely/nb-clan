import crypto from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { closeSqliteDatabases, openSqliteDatabase } from '../server/storage/sqlite.js';

const SECURE_DIRECTORY_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const BACKUP_FORMAT_VERSION = 1;

process.umask(0o077);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureSecureDirectory(directory) {
  const normalizedDirectory = path.resolve(directory);
  const dataDirectory = path.resolve(process.env.NB_DATA_DIR || path.join(process.cwd(), 'data'));
  let created = false;
  let directoryStat = null;
  try {
    directoryStat = await fs.stat(normalizedDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    created = true;
  }
  await fs.mkdir(directory, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  const isDataDirectory = normalizedDirectory === dataDirectory
    || normalizedDirectory.startsWith(`${dataDirectory}${path.sep}`);
  if (normalizedDirectory !== path.parse(normalizedDirectory).root && (created || isDataDirectory)) {
    await fs.chmod(directory, SECURE_DIRECTORY_MODE);
  } else if (!created && !isDataDirectory && ((directoryStat?.mode || 0) & 0o777) !== SECURE_DIRECTORY_MODE) {
    throw new Error(`Backup directory outside NB_DATA_DIR must already be mode 0700: ${normalizedDirectory}`);
  }
}

async function syncFile(file) {
  const handle = await fs.open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function pragmaValue(row) {
  return row && typeof row === 'object' ? Object.values(row)[0] : undefined;
}

async function normalizeSnapshotForStandaloneRestore(file) {
  const db = new DatabaseSync(file);
  try {
    const journalMode = String(pragmaValue(db.prepare('PRAGMA journal_mode = DELETE').get()) || '').toLowerCase();
    if (journalMode !== 'delete') throw new Error(`Could not finalize backup journal mode: ${journalMode || 'unknown'}`);
  } finally {
    db.close();
  }
  await Promise.all([
    fs.rm(`${file}-wal`, { force: true }),
    fs.rm(`${file}-shm`, { force: true })
  ]);
}

async function verifyRestoredCopy(file) {
  const restoreDir = await fs.mkdtemp(path.join(path.dirname(file), '.nb-clan-sqlite-restore-check-'));
  await fs.chmod(restoreDir, SECURE_DIRECTORY_MODE);
  const restoredFile = path.join(restoreDir, path.basename(file));
  let db;
  try {
    await fs.copyFile(file, restoredFile, fsConstants.COPYFILE_FICLONE);
    await fs.chmod(restoredFile, SECURE_FILE_MODE);
    db = new DatabaseSync(restoredFile, { readOnly: true });
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    const integrity = integrityRows.map((row) => String(pragmaValue(row) || ''));
    if (integrity.length !== 1 || integrity[0].toLowerCase() !== 'ok') {
      throw new Error(`Restored SQLite integrity check failed: ${integrity.filter(Boolean).join('; ') || 'no result'}`);
    }
    const schemaObjects = Number(db.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get()?.count || 0);
    const pageCount = Number(pragmaValue(db.prepare('PRAGMA page_count').get()) || 0);
    const userVersion = Number(pragmaValue(db.prepare('PRAGMA user_version').get()) || 0);
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    return {
      readable: true,
      integrity: 'ok',
      schemaObjects,
      pageCount,
      userVersion,
      foreignKeyViolations
    };
  } finally {
    try {
      db?.close();
    } finally {
      await fs.rm(restoreDir, { recursive: true, force: true });
    }
  }
}

async function writeAtomicFile(file, content) {
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempFile, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: SECURE_FILE_MODE
    });
    await syncFile(tempFile);
    await fs.link(tempFile, file);
    await fs.rm(tempFile);
    await fs.chmod(file, SECURE_FILE_MODE);
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

function checksumFileFor(target) {
  return `${target}.sha256`;
}

function manifestFileFor(target) {
  return `${target}.manifest.json`;
}

async function assertOutputsAbsent(target) {
  for (const file of [target, checksumFileFor(target), manifestFileFor(target)]) {
    if (await pathExists(file)) throw new Error(`Refusing to overwrite existing backup artifact: ${file}`);
  }
}

async function createBackup({ sqlite, target }) {
  const source = path.resolve(sqlite);
  const destination = path.resolve(target);
  if (source === destination) throw new Error('Backup target must differ from the live SQLite file');

  const sourceStat = await fs.stat(source).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`SQLite source does not exist: ${source}`);
    throw error;
  });
  if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error(`SQLite source is not a non-empty file: ${source}`);

  const backupDirectory = path.dirname(destination);
  await ensureSecureDirectory(backupDirectory);
  await assertOutputsAbsent(destination);

  const tempTarget = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const checksumFile = checksumFileFor(destination);
  const manifestFile = manifestFileFor(destination);
  let published = false;
  try {
    const sourceDb = await openSqliteDatabase(source);
    const pagesCopied = await backup(sourceDb, tempTarget);
    await fs.chmod(tempTarget, SECURE_FILE_MODE);
    await normalizeSnapshotForStandaloneRestore(tempTarget);
    const verification = await verifyRestoredCopy(tempTarget);
    await syncFile(tempTarget);

    const sha256 = await sha256File(tempTarget);
    const snapshotStat = await fs.stat(tempTarget);
    const createdAt = new Date().toISOString();
    const manifest = {
      version: BACKUP_FORMAT_VERSION,
      createdAt,
      source,
      snapshot: path.basename(destination),
      sizeBytes: snapshotStat.size,
      sha256,
      pagesCopied,
      verification
    };

    await fs.link(tempTarget, destination);
    published = true;
    await fs.rm(tempTarget);
    await fs.chmod(destination, SECURE_FILE_MODE);
    await writeAtomicFile(checksumFile, `${sha256}  ${path.basename(destination)}\n`);
    await writeAtomicFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const publishedHash = await sha256File(destination);
    if (publishedHash !== sha256) throw new Error('Published backup checksum changed after atomic rename');

    return {
      ok: true,
      sqlite: source,
      target: destination,
      checksumFile,
      manifestFile,
      sizeBytes: snapshotStat.size,
      sha256,
      pagesCopied,
      verification
    };
  } catch (error) {
    await Promise.all([
      fs.rm(tempTarget, { force: true }),
      fs.rm(`${tempTarget}-wal`, { force: true }),
      fs.rm(`${tempTarget}-shm`, { force: true })
    ]);
    if (published) {
      await Promise.all([
        fs.rm(destination, { force: true }),
        fs.rm(checksumFile, { force: true }),
        fs.rm(manifestFile, { force: true })
      ]);
    }
    throw error;
  } finally {
    await closeSqliteDatabases({ ignoreErrors: true });
  }
}

async function verifyBackup(target) {
  const destination = path.resolve(target);
  const checksumFile = checksumFileFor(destination);
  const manifestFile = manifestFileFor(destination);
  const [snapshotStat, checksumText, manifestText] = await Promise.all([
    fs.stat(destination),
    fs.readFile(checksumFile, 'utf8'),
    fs.readFile(manifestFile, 'utf8')
  ]);
  if (!snapshotStat.isFile() || snapshotStat.size <= 0) throw new Error(`Backup is not a non-empty file: ${destination}`);

  const expectedHash = checksumText.trim().split(/\s+/)[0]?.toLowerCase() || '';
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`Invalid checksum file: ${checksumFile}`);
  const actualHash = await sha256File(destination);
  if (actualHash !== expectedHash) throw new Error(`Backup checksum mismatch: expected ${expectedHash}, got ${actualHash}`);

  const manifest = JSON.parse(manifestText);
  if (manifest.version !== BACKUP_FORMAT_VERSION) throw new Error(`Unsupported backup manifest version: ${manifest.version}`);
  if (manifest.snapshot !== path.basename(destination)) throw new Error('Backup manifest snapshot name does not match the snapshot');
  if (manifest.sha256 !== actualHash) throw new Error('Backup manifest checksum does not match the snapshot');
  if (Number(manifest.sizeBytes) !== snapshotStat.size) throw new Error('Backup manifest size does not match the snapshot');
  const verification = await verifyRestoredCopy(destination);

  return {
    ok: true,
    target: destination,
    checksumFile,
    manifestFile,
    sizeBytes: snapshotStat.size,
    sha256: actualHash,
    verification
  };
}

const args = parseArgs(process.argv.slice(2));

try {
  let result;
  if (args.verify) {
    if (typeof args.verify !== 'string') throw new Error('Usage: --verify <backup.sqlite>');
    result = await verifyBackup(args.verify);
  } else {
    const sqlite = args.sqlite || 'data/nb-clan.sqlite';
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const target = args.target || `data/backups/nb-clan-${timestamp}.sqlite`;
    result = await createBackup({ sqlite, target });
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error)
  }, null, 2));
  process.exitCode = 1;
}
