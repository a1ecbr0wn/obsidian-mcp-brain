// Compare-and-swap write preconditions based on a file's last-modified time.
// No filesystem I/O here except the single stat assertUnmodified performs.

import fs from 'node:fs/promises';

const ISO_MTIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Formats a fs.Stats mtime the same way read-note and list-notes already do,
 * so there is exactly one implementation a client's expectedMtime is compared against.
 */
export function formatMtime(stat) {
  return stat.mtime.toISOString();
}

/**
 * Throws if expectedMtime isn't the exact ISO 8601 string read-note/list-notes emit
 * (a malformed value is rejected up front, before it's ever compared against a real
 * file, so the failure clearly names the bad input rather than surfacing as a
 * confusing mtime mismatch).
 */
export function validateExpectedMtime(expectedMtime) {
  if (typeof expectedMtime !== 'string' || !ISO_MTIME_RE.test(expectedMtime)) {
    throw new Error(`Invalid expectedMtime "${expectedMtime}": must be an ISO 8601 timestamp as returned by read-note/list-notes`);
  }
}

/**
 * Asserts that the file at absPath's current mtime matches expectedMtime, throwing a
 * precondition-failure error (naming both values) if it doesn't, or a distinct error if
 * the file no longer exists at all. Used as a compare-and-swap guard immediately before
 * a write, not as a lock — the window between this check and the write itself is not
 * closed, deliberately, since the realistic conflict this guards against is an edit
 * seconds or minutes old, not a same-instant race.
 */
export async function assertUnmodified(absPath, expectedMtime) {
  validateExpectedMtime(expectedMtime);
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Precondition failed: file no longer exists (expected mtime ${expectedMtime})`);
    }
    throw err;
  }
  const actual = formatMtime(stat);
  if (actual !== expectedMtime) {
    throw new Error(`Precondition failed: file was modified (expected mtime ${expectedMtime}, actual ${actual}). Re-read and retry.`);
  }
}
