// Pure helpers for upload-binary: the one-time upload slots, working out who a caller is,
// and the staging folder. Nothing here touches the HTTP server, so it is unit-testable.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A token is 32 random bytes, base64url-encoded, which is always 43 characters.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * In-memory store of pending uploads ("slots"). A slot records that one file of a given
 * size and hash may arrive at one destination, from one address, before an expiry. Only a
 * hash of each token is kept, so the stored records cannot be turned back into working
 * upload URLs. A slot is single-use: consume() removes it whatever the outcome.
 */
export class UploadSlots {
  #slots = new Map();
  #ttlMs;
  #maxOutstanding;
  #now;

  /**
   * @param {object} opts
   * @param {number} opts.ttlMs - How long a slot lives.
   * @param {number} opts.maxOutstanding - Most slots that may be pending at once.
   * @param {() => number} [opts.now] - Clock, injectable for tests.
   */
  constructor({ ttlMs, maxOutstanding, now = Date.now }) {
    this.#ttlMs = ttlMs;
    this.#maxOutstanding = maxOutstanding;
    this.#now = now;
  }

  /** Number of slots currently held (expired ones not yet swept are included). */
  get size() {
    return this.#slots.size;
  }

  /** The stored keys (token hashes). For tests only. */
  _keys() {
    return [...this.#slots.keys()];
  }

  /**
   * Reserves a slot and returns its token.
   * @param {{vault: string, relPath: string, size: number, sha256: string, address: string}} info
   * @returns {{token: string, expiresAt: number}}
   * @throws {Error} with code TOO_MANY_SLOTS when the outstanding-slot cap is reached, or
   *   NO_ADDRESS when address is empty (an empty address would match any other empty one).
   */
  create({ vault, relPath, size, sha256, address }) {
    if (!address) {
      const err = new Error('The caller address could not be determined');
      err.code = 'NO_ADDRESS';
      throw err;
    }
    this.sweep();
    if (this.#slots.size >= this.#maxOutstanding) {
      const err = new Error('Too many pending uploads');
      err.code = 'TOO_MANY_SLOTS';
      throw err;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#slots.set(hashToken(token), { vault, relPath, size, sha256: sha256.toLowerCase(), address, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Looks a token up and removes its slot, so it can never be used twice.
   * @param {unknown} token
   * @returns {object|null} The slot, or null if the token is malformed, unknown, used or expired.
   */
  consume(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const key = hashToken(token);
    const slot = this.#slots.get(key);
    if (!slot) return null;
    this.#slots.delete(key);
    return slot.expiresAt <= this.#now() ? null : slot;
  }

  /**
   * Removes expired slots.
   * @returns {number} How many were removed.
   */
  sweep() {
    const now = this.#now();
    let removed = 0;
    for (const [key, slot] of this.#slots) {
      if (slot.expiresAt <= now) {
        this.#slots.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

// ── Caller address ──────────────────────────────────────────────────────────

/**
 * Canonical form of an address: IPv4-mapped IPv6 unwrapped to IPv4 (dotted or hex notation),
 * IPv6 in its canonical compressed lower-case spelling, any zone identifier removed.
 * Anything else is returned unchanged.
 * @param {unknown} addr
 * @returns {string} '' for a missing value.
 */
export function normalizeAddress(addr) {
  if (typeof addr !== 'string' || !addr) return '';
  const a = addr.trim().split('%')[0];
  const lower = a.toLowerCase();
  let m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (net.isIPv6(lower)) {
    // Let the URL parser spell it canonically, so 2001:db8:0:0::1 and 2001:db8::1 compare equal.
    try {
      return new URL(`http://[${lower}]/`).hostname.slice(1, -1);
    } catch {
      return lower;
    }
  }
  return a;
}

/**
 * Compiles the trustedProxies setting: single addresses and CIDR ranges of both families.
 * @param {string[]} list
 * @returns {{isEmpty: boolean, check: (addr: string) => boolean}}
 * @throws {Error} naming the first entry that is not an address or CIDR range.
 */
export function compileTrustedProxies(list) {
  const blockList = new net.BlockList();
  for (const entry of list) {
    const bad = () => new Error(`Invalid trusted proxy ${JSON.stringify(entry)}: expected an IP address or a CIDR range such as 10.0.0.0/8`);
    if (typeof entry !== 'string') throw bad();
    const parts = entry.trim().split('/');
    if (parts.length > 2) throw bad();
    const [addrPart, prefixPart] = parts;
    const addr = normalizeAddress(addrPart);
    const family = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
    if (!family) throw bad();
    if (prefixPart === undefined) {
      blockList.addAddress(addr, family);
      continue;
    }
    // A prefix length on an IPv4-mapped IPv6 address would mean different things in the two families.
    if (addr !== addrPart.trim().toLowerCase() && addr !== addrPart.trim()) throw bad();
    if (!/^\d{1,3}$/.test(prefixPart)) throw bad();
    const prefix = parseInt(prefixPart, 10);
    if (prefix > (family === 'ipv4' ? 32 : 128)) throw bad();
    blockList.addSubnet(addr, prefix, family);
  }
  return {
    isEmpty: list.length === 0,
    check(addr) {
      const a = normalizeAddress(addr);
      if (net.isIPv4(a)) return blockList.check(a, 'ipv4');
      if (net.isIPv6(a)) return blockList.check(a, 'ipv6');
      return false;
    },
  };
}

/**
 * Works out who is really calling. This is the connection's peer address, unless that peer
 * is a trusted proxy, in which case X-Forwarded-For is read from the right, skipping entries
 * that are themselves trusted proxies: the first remaining entry is the caller. The header is
 * ignored from any other peer, because anyone can forge it. A malformed header from a trusted
 * proxy gives '', which matches nothing: refusing is safer than guessing.
 * @param {{socket?: {remoteAddress?: string}, headers: object}} req
 * @param {{isEmpty: boolean, check: (addr: string) => boolean}|null} trusted - From compileTrustedProxies.
 * @returns {string} '' if the address cannot be determined.
 */
export function callerAddress(req, trusted) {
  const peer = normalizeAddress(req.socket?.remoteAddress);
  if (!trusted || trusted.isEmpty || !trusted.check(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || !raw.trim()) return peer;
  const entries = raw.split(',').map(e => normalizeAddress(e.trim()));
  if (entries.some(e => !net.isIP(e))) return '';
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!trusted.check(entries[i])) return entries[i];
  }
  return entries[0];
}

// ── Staging folder ──────────────────────────────────────────────────────────

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

/**
 * Where uploads are staged unless uploadTempDir says otherwise: a folder under the temporary
 * directory named for the user, so two users on one machine do not share (or fight over) it.
 * @returns {string}
 */
export function defaultUploadTempDir() {
  const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return path.join(os.tmpdir(), `obsidian-mcp-uploads${uid}`);
}

/**
 * Checks that a staging folder (already resolved to its real path) is one only this user
 * controls. A folder owned by someone else, such as one pre-created in a shared temporary
 * directory, would let that person swap a file between its hash check and its placement.
 * @param {{isDirectory: () => boolean, uid: number}} stat - From fs.stat on the real path.
 * @param {number|undefined} uid - This process's user id; undefined where there is none (Windows).
 * @returns {string|null} An error message, or null if the folder is acceptable.
 */
export function checkStagingDirOwner(stat, uid) {
  if (!stat.isDirectory()) return 'is not a directory';
  if (uid !== undefined && stat.uid !== uid) return 'is owned by another user';
  return null;
}

/**
 * Works out where an upload's destination really is, following symbolic links in the part
 * that already exists, and whether it is still inside the vault. A symbolic link inside the
 * vault that points outside would otherwise let an upload write anywhere the server can.
 * @param {string} vaultPath - The vault's directory.
 * @param {string} relPath - Normalised vault-relative destination.
 * @returns {Promise<{ok: true, rel: string}|{ok: false}>} rel is the real vault-relative path.
 */
export async function resolveDestination(vaultPath, relPath) {
  const realVault = await fs.realpath(vaultPath);
  const segments = relPath.split('/');
  let current = realVault;
  let i = 0;
  for (; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    try {
      await fs.lstat(next);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
    current = await fs.realpath(next);
  }
  const real = path.join(current, ...segments.slice(i));
  const rel = path.relative(realVault, real);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { ok: false };
  return { ok: true, rel: rel.split(path.sep).join('/') };
}

/**
 * Checks a staging folder is usable: absolute, and neither inside a vault (a sync tool or
 * Obsidian would see half-received files) nor containing one.
 * @param {string} dir
 * @param {string[]} vaultPaths
 * @returns {string|null} An error message, or null if the folder is acceptable.
 */
export function checkStagingDir(dir, vaultPaths) {
  if (!path.isAbsolute(dir)) return 'must be an absolute path';
  const d = path.resolve(dir);
  for (const v of vaultPaths) {
    const vault = path.resolve(v);
    if (isInside(d, vault)) return 'must not be inside a vault';
    if (isInside(vault, d)) return 'must not contain a vault';
  }
  return null;
}

/**
 * Removes stale staging files left by an earlier run. Only files this module names
 * (upload-<hex>.part) are touched, because the folder may be configured by the owner and
 * hold other things.
 * @param {string} dir
 * @returns {Promise<number>} How many files were removed; 0 if the folder does not exist.
 */
export async function sweepStaging(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.isFile() && /^upload-[0-9a-f]+\.part$/.test(entry.name)) {
      await fs.unlink(path.join(dir, entry.name));
      removed++;
    }
  }
  return removed;
}

/**
 * A fresh, unpredictable name for a staging file.
 * @returns {string}
 */
export function stagingFileName() {
  return `upload-${crypto.randomBytes(8).toString('hex')}.part`;
}
