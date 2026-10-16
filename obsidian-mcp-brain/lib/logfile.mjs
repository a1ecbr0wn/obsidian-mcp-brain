/**
 * The log file: every line the server logs is also appended to it when `logFile` is set.
 * Lines are written synchronously, so none is lost when the process exits and the order is the
 * order they were logged in. The server does not rotate the file; `reopen` lets `logrotate`
 * move it and have the server start a new one on SIGHUP.
 */
import fs from 'node:fs';

/**
 * Opens (creating if needed) a log file for appending, readable by its owner only.
 * @param {string} filePath - Absolute path; the folder must exist.
 * @returns {{write: (line: string) => void, reopen: () => void, close: () => void, tightened: boolean}}
 *   `tightened` is true when an existing file was open to other users and was made owner-only.
 * @throws {Error} If the file cannot be opened or its permissions cannot be restricted.
 */
export function openLogFile(filePath) {
  let fd = null;
  let failed = false;
  let tightened = false;

  const open = () => {
    const next = fs.openSync(filePath, 'a', 0o600);
    try {
      // The mode above only applies to a file this call creates.
      if (fs.fstatSync(next).mode & 0o077) {
        fs.fchmodSync(next, 0o600);
        tightened = true;
      }
    } catch (err) {
      fs.closeSync(next);
      throw err;
    }
    if (fd !== null) fs.closeSync(fd);
    fd = next;
    failed = false;
  };
  open();

  return {
    get tightened() { return tightened; },
    /**
     * Appends one line. A write that fails is reported once on stderr and then dropped; the next
     * write that succeeds clears that, so a later failure is reported again.
     */
    write(line) {
      if (fd === null) return;
      try {
        const bytes = Buffer.from(line + '\n');
        for (let written = 0; written < bytes.length;) written += fs.writeSync(fd, bytes, written);
        failed = false;
      } catch (err) {
        if (!failed) console.error(`${new Date().toISOString()} cannot write to the log file ${filePath}: ${err.message}`);
        failed = true;
      }
    },
    /** Closes the file and opens the path again, for after logrotate has moved it. */
    reopen() {
      open();
    },
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}
