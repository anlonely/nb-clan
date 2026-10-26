import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { need, sha, nowIso } from './model.js';

function assertDirectory(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    need(!fs.lstatSync(current).isSymbolicLink(), 'STORAGE_SYMLINK_FORBIDDEN', 409);
  }
  need(fs.statSync(absolute).isDirectory(), 'STORAGE_DIRECTORY_REQUIRED');
  return absolute;
}
function checkedFile(dir, name, { exists = true } = {}) {
  need(/^[a-z0-9_.-]+$/i.test(name) && !name.includes('..'), 'INVALID_ARTIFACT_ID');
  assertDirectory(dir); const file = path.join(dir, name);
  if (fs.existsSync(file)) need(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'STORAGE_SYMLINK_FORBIDDEN', 409);
  else need(!exists, 'ARTIFACT_FILE_MISSING', 409);
  return file;
}
function integrity(filename) {
  const candidate = new DatabaseSync(filename, { readOnly: true });
  try {
    need(candidate.prepare('PRAGMA integrity_check').all().every(r => Object.values(r)[0] === 'ok'), 'BACKUP_INTEGRITY_FAILED', 409);
    const records = candidate.prepare('SELECT count(*) n FROM json_records').get().n;
    return { integrity: 'ok', records };
  } finally { candidate.close(); }
}
/** Explicit filesystem boundary: inspect only managed artifacts and the injected live DB.
 * VACUUM INTO captures committed SQLite + WAL state. Restore makes a verified candidate;
 * activation belongs to the host's drain/close/reopen lifecycle, never to a live HTTP request.
 */
export function createLocalSystemStorage({ db, directory, databaseFile }) {
  need(db && directory && databaseFile, 'STORAGE_ADAPTER_REQUIRED', 503);
  const dir = assertDirectory(directory), dbFile = path.resolve(databaseFile);
  assertDirectory(path.dirname(dbFile));
  need(fs.lstatSync(dbFile).isFile() && !fs.lstatSync(dbFile).isSymbolicLink(), 'STORAGE_SYMLINK_FORBIDDEN');
  const actual = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main')?.file;
  need(actual && fs.realpathSync(actual) === fs.realpathSync(dbFile), 'STORAGE_DATABASE_MISMATCH', 503);
  function metadata(id, kind, fileName, detail = {}) {
    const file = checkedFile(dir, fileName), bytes = fs.readFileSync(file);
    return { id, kind, state: 'active', revision: 1, fileName, bytes: bytes.length, sha256: sha(bytes), createdAt: nowIso(), ...detail };
  }
  return {
    status() {
      assertDirectory(dir);
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      need(entries.length <= 10000, 'STORAGE_SCAN_LIMIT', 503);
      let bytes = 0, files = 0;
      for (const e of entries) if (e.isFile() && !e.isSymbolicLink()) { files++; bytes += fs.statSync(checkedFile(dir, e.name)).size; }
      const disk = fs.statfsSync(dir);
      return { managedBytes: bytes, managedFileCount: files, databaseBytes: fs.statSync(dbFile).size,
        availableBytes: Number(disk.bavail) * Number(disk.bsize), boundary: 'managed-artifacts-and-authoritative-database', checkedAt: nowIso() };
    },
    upload(id, bytes, ext) {
      const name = `logo-${id}.${ext}`, file = checkedFile(dir, name, { exists: false });
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      need(sha(fs.readFileSync(file)) === sha(bytes), 'ARTIFACT_CONTENT_CONFLICT', 409);
      return metadata(id, 'logo', name);
    },
    backup(id) {
      const name = `backup-${id}.sqlite`, file = checkedFile(dir, name, { exists: false });
      if (!fs.existsSync(file)) {
        const partial = checkedFile(dir, `${name}.partial`, { exists: false });
        // This partial belongs exclusively to this operation. It is never a source file.
        if (fs.existsSync(partial)) fs.unlinkSync(partial);
        db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
        fs.chmodSync(partial, 0o600); integrity(partial); fs.renameSync(partial, file);
      }
      return metadata(id, 'backup', name, integrity(file));
    },
    restore(id, artifact) {
      need(artifact.kind === 'backup' && artifact.state === 'active', 'BACKUP_REQUIRED', 409);
      const source = checkedFile(dir, artifact.fileName);
      need(sha(fs.readFileSync(source)) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH', 409);
      const name = `restored-${id}.sqlite`, target = checkedFile(dir, name, { exists: false });
      if (!fs.existsSync(target)) { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600); }
      need(sha(fs.readFileSync(target)) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH', 409);
      return metadata(id, 'restore_candidate', name, { ...integrity(target), backupId: artifact.id, activation: 'requires_owner_drain_close_reopen' });
    },
    quarantine(artifact) {
      const source = checkedFile(dir, artifact.fileName, { exists: false });
      const target = checkedFile(dir, `${artifact.fileName}.quarantine`, { exists: false });
      need(!fs.existsSync(source) || !fs.existsSync(target), 'ARTIFACT_STATE_CONFLICT', 409);
      const file = fs.existsSync(source) ? source : target;
      need(fs.existsSync(file) && sha(fs.readFileSync(file)) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH', 409);
      if (file === source) fs.renameSync(source, target);
      return { ...artifact, state: 'quarantined', revision: artifact.revision + 1 };
    },
    recover(artifact) {
      const target = checkedFile(dir, artifact.fileName, { exists: false });
      const source = checkedFile(dir, `${artifact.fileName}.quarantine`, { exists: false });
      need(!fs.existsSync(source) || !fs.existsSync(target), 'ARTIFACT_STATE_CONFLICT', 409);
      const file = fs.existsSync(source) ? source : target;
      need(fs.existsSync(file) && sha(fs.readFileSync(file)) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH', 409);
      if (file === source) fs.renameSync(source, target);
      return { ...artifact, state: 'active', revision: artifact.revision + 1 };
    },
    readLogo(artifact) {
      need(artifact.kind === 'logo' && artifact.state === 'active', 'RESOURCE_NOT_FOUND', 404);
      const buffer = fs.readFileSync(checkedFile(dir, artifact.fileName));
      need(sha(buffer) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH', 409); return buffer;
    },
    // Server-owner use only. Never expose this path or database bytes through the browser DTO.
    candidatePath(artifact) { need(artifact.kind === 'restore_candidate', 'RESTORE_CANDIDATE_REQUIRED'); return checkedFile(dir, artifact.fileName); }
  };
}
export function artifactDTO(a) {
  return { id: a.id, kind: a.kind, state: a.state, revision: a.revision, bytes: a.bytes, sha256: a.sha256,
    createdAt: a.createdAt, integrity: a.integrity, records: a.records, backupId: a.backupId, activation: a.activation };
}
