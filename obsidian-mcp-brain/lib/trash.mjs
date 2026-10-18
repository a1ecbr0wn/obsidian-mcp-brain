// The vault's .trash folder: how the server names and moves what it puts there, and how it
// empties the folder of what has been there too long. A file the server trashes is named
// `<stem>_<epoch milliseconds><ext>`, so no two files collide and the name says when it was
// trashed. That time is for people: how long a file has been in .trash is judged by its ctime
// (see purgeTrash), because a name can be anything.

import fs from 'node:fs/promises';
import path from 'node:path';

export const TRASH_DIR = '.trash';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_BYTES = 255;

/**
 * The first characters of `text` that fit in `maxBytes` bytes of UTF-8, never cutting a
 * character in half.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateBytes(text, maxBytes) {
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return out;
}

/**
 * The name a file gets in .trash: its stem, an underscore, the time in epoch milliseconds, and
 * its own extension (a note keeps `.md`, `foo.excalidraw.md` becomes `foo.excalidraw_<ms>.md`).
 * A stem too long for the whole name to fit in 255 bytes is cut short.
 * @param {string} fileName - The file's base name.
 * @param {number} time - Epoch milliseconds.
 * @returns {string}
 */
export function trashName(fileName, time) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  const suffix = `_${time}${ext}`;
  return `${truncateBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}

/**
 * Makes sure the vault's .trash is a real folder (not a link that would lead somewhere else),
 * creating it if it is missing.
 * @param {string} vaultPath - Absolute path of the vault root.
 * @returns {Promise<string>} The absolute path of .trash.
 * @throws {Error} If .trash exists and is not a real folder.
 */
async function ensureTrashDir(vaultPath) {
  const trashDir = path.join(vaultPath, TRASH_DIR);
  let stat;
  try {
    stat = await fs.lstat(trashDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.mkdir(trashDir, { recursive: true });
    return trashDir;
  }
  if (!stat.isDirectory()) throw new Error(`${TRASH_DIR} is not a real folder`);
  return trashDir;
}

/**
 * A free path in .trash for a file about to be moved there, named by trashName. A name that is
 * taken (another file trashed in the same millisecond) moves on to the next millisecond until
 * one is free. Creates .trash if it is missing. The name is free when checked: the caller must
 * still create it exclusively (a hard link, or a copy with COPYFILE_EXCL) and retry on EEXIST;
 * moveToTrash does.
 * @param {string} absPath - Absolute path of the file about to be trashed.
 * @param {string} vaultPath - Absolute path of the vault root.
 * @param {number} [now] - Epoch milliseconds, injectable for tests.
 * @returns {Promise<string>} Absolute path in .trash.
 * @throws {Error} If .trash is not a real folder.
 */
export async function trashDestination(absPath, vaultPath, now = Date.now()) {
  const trashDir = await ensureTrashDir(vaultPath);
  const base = path.basename(absPath);
  for (let time = now; ; time++) {
    const candidate = path.join(trashDir, trashName(base, time));
    try {
      await fs.lstat(candidate);
    } catch (err) {
      if (err.code === 'ENOENT') return candidate;
      throw err;
    }
  }
}

/**
 * Moves a file into .trash without ever replacing a file that is already there: the file is
 * hard-linked to its new name (which fails if the name exists, and the next name is tried) and
 * the old name removed. On a filesystem without hard links it falls back to a plain rename.
 * @param {string} absPath - Absolute path of the file to trash.
 * @param {string} vaultPath - Absolute path of the vault root.
 * @returns {Promise<string>} Absolute path the file now has in .trash.
 * @throws {Error} If .trash is not a real folder, or the file cannot be moved.
 */
export async function moveToTrash(absPath, vaultPath) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const dest = await trashDestination(absPath, vaultPath);
    try {
      await fs.link(absPath, dest);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK'].includes(err.code)) {
        await fs.rename(absPath, dest);
        return dest;
      }
      throw err;
    }
    try {
      await fs.unlink(absPath);
    } catch (err) {
      await fs.unlink(dest).catch(() => {});
      throw err;
    }
    return dest;
  }
  throw new Error('no free name in .trash');
}

/**
 * Deletes what has been in a vault's .trash for longer than a limit. A file's age is the time
 * since its ctime, or since the newest ctime among the folders it sits in below .trash if that
 * is later (a folder moved into .trash is renamed, which changes its own ctime and not its
 * files'). A ctime is never earlier than the moment a file was moved into .trash, so this can
 * only make a file look younger than it is, which is the safe way to be wrong; a file whose
 * age cannot be worked out is kept. Folders that this leaves empty, and empty folders older
 * than the limit, are removed; .trash itself never is.
 *
 * Nothing outside .trash is touched: .trash must be a real folder, every entry is read
 * without following links, a symbolic link is removed as a link, and before each folder is read
 * and each file removed the folder's real path is checked to be where the walk believes it is.
 * That check does not close a window of a few microseconds in which another process could
 * swap a folder for a link. A file that disappears during the run is not an error; any other
 * failure on one entry is counted and reported, and the run goes on.
 * @param {object} opts
 * @param {string} opts.vaultPath - Absolute path of the vault root.
 * @param {number} opts.maxAgeDays - Files older than this many days are deleted: a number above 0.
 * @param {number} [opts.now] - Epoch milliseconds, injectable for tests.
 * @param {(info: {path: string, bytes: number, ageDays: number}) => void} [opts.onRemoved] - Called for each file deleted; path is relative to the vault.
 * @param {(info: {path: string, error: Error}) => void} [opts.onError]
 * @returns {Promise<{files: number, bytes: number, errors: number}>}
 * @throws {Error} If maxAgeDays is not a finite number above 0, or .trash is not a real folder.
 */
export async function purgeTrash({ vaultPath, maxAgeDays, now = Date.now(), onRemoved, onError }) {
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`maxAgeDays must be a number above 0, not ${String(maxAgeDays)}`);
  }
  const root = path.join(vaultPath, TRASH_DIR);
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    if (err.code === 'ENOENT') return { files: 0, bytes: 0, errors: 0 };
    throw err;
  }
  if (!rootStat.isDirectory()) throw new Error(`${TRASH_DIR} is not a real folder`);
  const realRoot = await fs.realpath(root);
  const result = { files: 0, bytes: 0, errors: 0 };
  const maxAgeMs = maxAgeDays * DAY_MS;
  const fail = (target, error) => {
    result.errors++;
    onError?.({ path: path.relative(vaultPath, target), error });
  };
  const tooOld = (ctimeMs) => now - ctimeMs > maxAgeMs; // false for NaN: such a file is kept

  // The folder's real path must be the one the walk expects: no link anywhere on the way.
  const stillThere = async (dir) => (await fs.realpath(dir)) === path.join(realRoot, path.relative(root, dir));

  // Returns whether it deleted anything below `dir`.
  const walk = async (dir, floorMs) => {
    let removedHere = false;
    let entries;
    try {
      if (!(await stillThere(dir))) throw new Error('a folder in .trash was replaced by a link');
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') fail(dir, err);
      return false;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          const dirStat = await fs.lstat(full);
          if (!dirStat.isDirectory()) continue; // swapped for something else since it was listed
          const floor = Math.max(floorMs, dirStat.ctimeMs);
          const removedBelow = await walk(full, floor);
          if (removedBelow) removedHere = true;
          if (removedBelow || tooOld(floor)) {
            await fs.rmdir(full).catch(err => {
              if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(err.code)) throw err;
            });
          }
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const stat = await fs.lstat(full);
          const age = now - Math.max(stat.ctimeMs, floorMs);
          if (!(age > maxAgeMs)) continue;
          if (!(await stillThere(dir))) throw new Error('a folder in .trash was replaced by a link');
          await fs.unlink(full);
          removedHere = true;
          result.files++;
          result.bytes += stat.size;
          onRemoved?.({ path: path.relative(vaultPath, full), bytes: stat.size, ageDays: Math.floor(age / DAY_MS) });
        }
      } catch (err) {
        if (err.code !== 'ENOENT') fail(full, err);
      }
    }
    return removedHere;
  };
  await walk(root, 0);
  return result;
}

const printable = (value) => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

/**
 * Runs purgeTrash on every vault whose trashRetentionDays is above 0, reporting what it did:
 * `audit('trash-purged', …)` for each file removed, `audit('trash-purge', …)` for a vault where
 * anything was removed or failed, and one `log` line per vault per run. Never throws: a vault
 * whose .trash cannot be purged is reported with `logErr` and the others still run.
 * @param {Record<string, {path: string, trashRetentionDays: number}>} vaults - By vault name.
 * @param {object} reporters
 * @param {(event: string, fields: object) => void} reporters.audit
 * @param {(message: string) => void} reporters.log
 * @param {(message: string) => void} reporters.logErr
 * @param {number} [now] - Epoch milliseconds, injectable for tests.
 * @returns {Promise<void>}
 */
export async function purgeVaults(vaults, { audit, log, logErr }, now = Date.now()) {
  for (const [name, vault] of Object.entries(vaults)) {
    if (vault.trashRetentionDays === 0) continue;
    try {
      const result = await purgeTrash({
        vaultPath: vault.path,
        maxAgeDays: vault.trashRetentionDays,
        now,
        onRemoved: ({ path: rel, bytes, ageDays }) => audit('trash-purged', { vault: name, path: rel, bytes, age_days: ageDays }),
        onError: ({ path: rel, error }) => logErr(`trash purge of ${printable(name)}: cannot remove ${printable(rel)}: ${error.code ?? printable(error.message)}`),
      });
      if (result.files || result.errors) audit('trash-purge', { vault: name, files: result.files, bytes: result.bytes, errors: result.errors });
      log(`trash purge of ${printable(name)}: ${result.files} file(s) older than ${vault.trashRetentionDays} day(s) removed`);
    } catch (err) {
      logErr(`trash purge of ${printable(name)} failed: ${printable(err.message)}`);
    }
  }
}
