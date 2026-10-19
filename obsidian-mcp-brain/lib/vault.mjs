// Filesystem operations for vault notes.
// Callers are responsible for path validation and access control.

import fs from 'node:fs/promises';
import path from 'node:path';
import { rewriteLinks, extractReferences } from './wikilinks.mjs';
import { isDenied, matchesExtension } from './access.mjs';
import { moveToTrash } from './trash.mjs';
import { isValidUtf8Buffer } from './uploads.mjs';

/**
 * True if the file name is a markdown note: it ends in `.md`, in any letter case. This is
 * the single definition of "a note" for the note walker and for the tools that send a caller
 * to the note tools, so a name is always exactly one of note or not-a-note and cannot fall
 * between two checks. Link match keys, the trash name and the move-rewrite use it too. Obsidian
 * opens a `.MD` file as a note (checked by the owner), which is why the match is
 * case-insensitive.
 * @param {string} name - A file name or a vault-relative path.
 * @returns {boolean}
 */
export function isNoteFile(name) {
  return /\.md$/i.test(name);
}

/**
 * Recursively walks vault directories, calling callback for each markdown file.
 * Skips directories and files starting with '.' (e.g., .trash, .obsidian, .git).
 * @param {string} dir - Directory to walk
 * @param {Function} cb - Async callback receiving absolute path of each .md file
 */
export async function walkVault(dir, cb) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip .trash, .obsidian, .git, etc.
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkVault(full, cb);
    } else if (entry.isFile() && isNoteFile(entry.name)) {
      await cb(full);
    }
  }
}

/**
 * Recursively walks vault directories, calling callback for every file regardless of
 * extension. Skips directories and files starting with '.' (e.g., .trash, .obsidian, .git).
 * Unlike walkVault, this visits binary files too — needed since a wikilink can resolve to one.
 * Symbolic links are neither followed nor passed to cb.
 * @param {string} dir - Directory to walk
 * @param {Function} cb - Async callback receiving absolute path of each file
 */
export async function walkAllFiles(dir, cb) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip .trash, .obsidian, .git, etc.
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAllFiles(full, cb);
    } else if (entry.isFile()) {
      await cb(full);
    }
  }
}

/**
 * The files a listing tool shows: every file in the vault, or under `relScope`, whose extension
 * matches the pattern and that `denyPaths` does not hide, sorted by path, each with its stat.
 * This is the one place `list-notes` and `list-files` decide what is listed, so they cannot
 * drift apart. Hidden names and symbolic links are never listed. A file that disappears between
 * the walk and its stat, or is swapped for anything but a regular file (a link, say), is left out.
 *
 * A `relScope` that is a symbolic link, or has one among its segments, lists nothing, and so does
 * one that does not exist: the walk would otherwise follow a link out of the vault or into a denied
 * folder that the deny check (which sees only the path as written) cannot recognise.
 *
 * A `relScope` with a hidden segment (.obsidian, .git, .trash, or anything under one) lists only
 * notes, whatever the extension, as list-notes always did. The walker skips hidden names below the
 * scope but not the scope's own segments, so this rule is applied here.
 * The caller checks `relScope` against denyPaths and `extension` with extensionPatternError.
 * @param {string} vaultPath - Absolute path of the vault.
 * @param {string|null} relScope - Vault-relative folder to list, or null for the whole vault.
 * @param {string} extension - A pattern that passed extensionPatternError; `*` matches every file.
 *   list-notes passes `md`, list-files passes the caller's pattern (default `*`).
 * @param {string[]} denyPaths - The vault's denied paths.
 * @returns {Promise<Array<{rel: string, stat: import('node:fs').Stats}>>}
 */
export async function listVaultFiles(vaultPath, relScope, extension, denyPaths) {
  const scopePath = relScope ? path.join(vaultPath, relScope) : vaultPath;
  if (relScope) {
    let walked = vaultPath;
    for (const seg of relScope.split('/').filter(Boolean)) {
      walked = path.join(walked, seg);
      try {
        if ((await fs.lstat(walked)).isSymbolicLink()) return [];
      } catch {
        return []; // a missing segment: nothing to list
      }
    }
  }
  const hiddenScope = relScope ? relScope.split('/').some(seg => seg.startsWith('.')) : false;
  const rels = [];
  await walkAllFiles(scopePath, async (filePath) => {
    const rel = path.relative(vaultPath, filePath);
    if (hiddenScope && !isNoteFile(rel)) return;
    if (!matchesExtension(extension, rel)) return;
    if (isDenied(denyPaths, rel)) return;
    rels.push(rel);
  });
  rels.sort();
  const files = [];
  for (const rel of rels) {
    try {
      const stat = await fs.lstat(path.join(vaultPath, rel));
      if (stat.isFile()) files.push({ rel, stat });
    } catch {
      // gone since the walk: not part of the vault any more
    }
  }
  return files;
}

/**
 * Computes the match key for a vault-relative path: the .md extension, in any letter case,
 * is stripped for notes (so links match their extensionless target, as Obsidian resolves
 * [[Foo]] to Foo.MD), kept for everything else (so embeds,
 * which reference the full filename, match exactly).
 */
function matchKeyFor(relPath) {
  return isNoteFile(relPath) ? relPath.replace(/\.md$/i, '') : relPath;
}

/**
 * Finds every note that links to or embeds the given target file (a note or binary file),
 * matching by the target's match key or bare basename — the same rule rewriteLinks uses.
 * Basename matching can over-attribute when the basename is ambiguous elsewhere in the
 * vault (e.g. a `[[sauce]]` link is reported against every file named "sauce", the same
 * limitation rewriteLinks/moveNote already have) — use resolve-wikilink first to check
 * whether a target is unambiguous.
 * @param {string} vaultPath - Absolute path to vault root
 * @param {string} targetRelPath - Vault-relative path of the target file
 * @param {string[]} denyPaths - Vault-relative paths excluded from the results
 * @returns {Promise<string[]>} Sorted vault-relative paths of notes referencing the target
 */
export async function findBacklinks(vaultPath, targetRelPath, denyPaths) {
  const matchKey = matchKeyFor(targetRelPath);
  const basename = path.posix.basename(matchKey);
  const results = [];

  await walkVault(vaultPath, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    if (rel === targetRelPath) return; // a note doesn't "backlink" to itself
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const refs = extractReferences(content);
    if (refs.some(r => r.target === matchKey || r.target === basename)) {
      results.push(rel);
    }
  });

  results.sort();
  return results;
}

/**
 * Resolves a raw wikilink target string (as passed to rewriteLinks — no [[ ]], heading,
 * or alias) to the vault file(s) whose match key or basename equals it. Zero results
 * means the target doesn't resolve; more than one means it's ambiguous.
 * @param {string} vaultPath - Absolute path to vault root
 * @param {string} target - Raw wikilink target string
 * @param {string[]} denyPaths - Vault-relative paths excluded from the results
 * @returns {Promise<string[]>} Sorted vault-relative paths matching the target
 */
export async function resolveWikilink(vaultPath, target, denyPaths) {
  const results = [];

  await walkAllFiles(vaultPath, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    const matchKey = matchKeyFor(rel);
    const basename = path.posix.basename(matchKey);
    if (matchKey === target || basename === target) {
      results.push(rel);
    }
  });

  results.sort();
  return results;
}

/**
 * Reads note content from disk.
 */
export async function readNote(absPath) {
  return fs.readFile(absPath, 'utf8');
}

/**
 * Writes note content to disk, creating parent directories as needed.
 */
export async function writeNote(absPath, content) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
}

/**
 * Deletes a note permanently or moves it to .trash, under a name that carries the time (see trashName).
 * @param {string} absPath - Absolute path to note
 * @param {boolean} permanent - If true, permanently delete; if false, move to .trash
 * @param {string} vaultPath - Absolute path to vault root
 */
export async function deleteNote(absPath, permanent, vaultPath) {
  if (permanent) {
    await fs.unlink(absPath);
  } else {
    await moveToTrash(absPath, vaultPath);
  }
}

/**
 * Moves note from srcAbs to dstAbs, then rewrites all vault-wide wikilinks to the old path.
 * Throws if destination already exists. Updates are best-effort; fails silently for inaccessible notes.
 * @param {string} vaultPath - Absolute path to vault root
 * @param {string} srcAbs - Absolute path to source note
 * @param {string} dstAbs - Absolute path to destination note
 * @param {string[]} denyPaths - Vault-relative paths to exclude from rewriting
 */
export async function moveNote(vaultPath, srcAbs, dstAbs, denyPaths) {
  // Guard against silently clobbering an existing note
  try {
    await fs.access(dstAbs);
    throw new Error(`Destination already exists: ${path.relative(vaultPath, dstAbs)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(dstAbs), { recursive: true });

  const oldRel = path.relative(vaultPath, srcAbs).replace(/\.md$/i, '');
  const newRel = path.relative(vaultPath, dstAbs).replace(/\.md$/i, '');

  await fs.rename(srcAbs, dstAbs);

  // Rewrite links in every other vault note
  await walkVault(vaultPath, async filePath => {
    if (filePath === dstAbs) return;
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const updated = rewriteLinks(content, oldRel, newRel);
    if (updated !== content) {
      try {
        await fs.writeFile(filePath, updated, 'utf8');
      } catch {
        return; // best-effort: log failure without aborting remaining rewrites
      }
    }
  });
}

/**
 * Reads binary file content from disk.
 */
export async function readBinaryFile(absPath) {
  return fs.readFile(absPath);
}

/**
 * Writes a file's bytes to disk, creating parent directories as needed.
 * @param {string} absPath - Absolute path to write
 * @param {Buffer} buffer - The file's bytes
 * @param {{exclusive?: boolean}} [options] - With `exclusive` the write fails with EEXIST if anything
 *   (a dangling link included) is already at the path, instead of replacing it.
 */
export async function writeBinaryFile(absPath, buffer, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, buffer, exclusive ? { flag: 'wx' } : undefined);
}

/**
 * Why bytes cannot be written to a path as they are: a note (.md) is text that the note tools
 * parse, so its bytes must be valid UTF-8. Any other file takes any bytes.
 * @param {string} relPath - Vault-relative destination.
 * @param {Buffer} buffer - The bytes to write.
 * @returns {string|null} An error message, or null if the write may go ahead.
 */
export function noteBytesError(relPath, buffer) {
  return isNoteFile(relPath) && !isValidUtf8Buffer(buffer) ? 'a note must be valid UTF-8 text' : null;
}

/**
 * Deletes a file of any type (what delete-file calls, a note included) permanently or moves it to
 * .trash, under a name that carries the time (see trashName).
 * @param {string} absPath - Absolute path to the file
 * @param {boolean} permanent - If true, permanently delete; if false, move to .trash
 * @param {string} vaultPath - Absolute path to vault root
 */
export async function deleteBinaryFile(absPath, permanent, vaultPath) {
  if (permanent) {
    await fs.unlink(absPath);
  } else {
    await moveToTrash(absPath, vaultPath);
  }
}

/**
 * Moves a binary file from srcAbs to dstAbs, then rewrites all vault-wide wikilink embeds
 * pointing at the old path. Throws if destination already exists.
 *
 * Unlike moveNote, the filename (including extension) is kept intact when rewriting, since
 * embeds reference binary files by their full filename rather than an extensionless basename.
 * @param {string} vaultPath - Absolute path to vault root
 * @param {string} srcAbs - Absolute path to source file
 * @param {string} dstAbs - Absolute path to destination file
 * @param {string[]} denyPaths - Vault-relative paths to exclude from rewriting
 */
export async function moveBinaryFile(vaultPath, srcAbs, dstAbs, denyPaths) {
  // Guard against silently clobbering an existing file
  try {
    await fs.access(dstAbs);
    throw new Error(`Destination already exists: ${path.relative(vaultPath, dstAbs)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(dstAbs), { recursive: true });

  const oldRel = path.relative(vaultPath, srcAbs);
  const newRel = path.relative(vaultPath, dstAbs);

  await fs.rename(srcAbs, dstAbs);

  // Rewrite embeds in every vault note (walkVault only visits .md files, so the moved
  // binary file itself is never read as text)
  await walkVault(vaultPath, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const updated = rewriteLinks(content, oldRel, newRel);
    if (updated !== content) {
      try {
        await fs.writeFile(filePath, updated, 'utf8');
      } catch {
        return; // best-effort: log failure without aborting remaining rewrites
      }
    }
  });
}

/**
 * Searches note content for query (case-insensitive).
 * @returns {Promise<Array<{path: string, matches: Array<{line: number, text: string}>}>>} Results sorted by path.
 */
export async function searchContent(vaultPath, query, scopeDir, denyPaths) {
  const lower = query.toLowerCase();
  const results = [];

  await walkVault(scopeDir, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }
    const matches = content
      .split(/\r?\n/)
      .reduce((acc, text, i) => {
        if (text.toLowerCase().includes(lower)) acc.push({ line: i + 1, text });
        return acc;
      }, []);
    if (matches.length > 0) {
      results.push({ path: rel, matches });
    }
  });

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Searches note filenames and vault-relative paths for query (case-insensitive).
 * @returns {Promise<string[]>} Vault-relative paths, sorted.
 */
export async function searchFilename(vaultPath, query, scopeDir, denyPaths) {
  const lower = query.toLowerCase();
  const results = [];

  await walkVault(scopeDir, async filePath => {
    const rel = path.relative(vaultPath, filePath);
    if (isDenied(denyPaths, rel)) return;
    if (rel.toLowerCase().includes(lower)) {
      results.push(rel);
    }
  });

  results.sort();
  return results;
}
