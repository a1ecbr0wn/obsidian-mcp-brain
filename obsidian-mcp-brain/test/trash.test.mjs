import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trashName, trashDestination, moveToTrash, purgeTrash, purgeVaults } from '../lib/trash.mjs';

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('trashName', () => {
  it('puts the time between the stem and the extension', () => {
    assert.equal(trashName('report.pdf', 1760000000000), 'report_1760000000000.pdf');
    assert.equal(trashName('Note.MD', 1760000000000), 'Note_1760000000000.MD');
    assert.equal(trashName('drawing.excalidraw.md', 1760000000000), 'drawing.excalidraw_1760000000000.md');
  });

  it('handles a name with no extension and a name that starts with a dot', () => {
    assert.equal(trashName('README', 1760000000000), 'README_1760000000000');
    assert.equal(trashName('.hidden', 1760000000000), '.hidden_1760000000000');
  });

  it('cuts a long stem so the whole name fits in 255 bytes, keeping the time and the extension', () => {
    const long = trashName(`${'a'.repeat(300)}.pdf`, 1760000000000);
    assert.equal(Buffer.byteLength(long), 255);
    assert.ok(long.endsWith('_1760000000000.pdf'));
    const wide = trashName(`${'日'.repeat(100)}.md`, 1760000000000);
    assert.ok(Buffer.byteLength(wide) <= 255, String(Buffer.byteLength(wide)));
    assert.ok(wide.endsWith('_1760000000000.md'));
    assert.ok(!wide.includes('�'), 'no character is cut in half');
  });

  it('leaves a name that fits alone', () => {
    const name = `${'a'.repeat(200)}.pdf`;
    assert.equal(trashName(name, 1760000000000), `${'a'.repeat(200)}_1760000000000.pdf`);
  });
});

describe('with a vault', () => {
  let vault;
  beforeEach(async () => { vault = await fs.mkdtemp(path.join(os.tmpdir(), 'trash-test-')); });
  afterEach(async () => { await fs.rm(vault, { recursive: true, force: true }); });

  const put = async (rel, bytes = 'x') => {
    const file = path.join(vault, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  const exists = (p) => fs.lstat(p).then(() => true, () => false);
  /** The time `days` days after a file's ctime: the moment it counts as that old. */
  const after = async (file, days) => (await fs.lstat(file)).ctimeMs + days * DAY;

  describe('trashDestination', () => {
    it('creates .trash and names the file by the time', async () => {
      const dest = await trashDestination(path.join(vault, 'a/b.pdf'), vault, 1760000000000);
      assert.equal(dest, path.join(vault, '.trash', 'b_1760000000000.pdf'));
      assert.ok((await fs.stat(path.join(vault, '.trash'))).isDirectory());
    });

    it('moves on to the next millisecond when the name is taken, also by a dangling link', async () => {
      await put('.trash/b_1760000000000.pdf');
      await fs.symlink('/nonexistent-target', path.join(vault, '.trash', 'b_1760000000001.pdf'));
      assert.equal(await trashDestination(path.join(vault, 'b.pdf'), vault, 1760000000000), path.join(vault, '.trash', 'b_1760000000002.pdf'));
    });

    it('refuses a .trash that is a link or a file, and creates nothing through it', async () => {
      await fs.mkdir(path.join(vault, 'elsewhere'));
      await fs.symlink(path.join(vault, 'elsewhere'), path.join(vault, '.trash'));
      await assert.rejects(trashDestination(path.join(vault, 'b.pdf'), vault), /not a real folder/);
      assert.deepEqual(await fs.readdir(path.join(vault, 'elsewhere')), []);
      await fs.rm(path.join(vault, '.trash'));
      await fs.writeFile(path.join(vault, '.trash'), 'x');
      await assert.rejects(trashDestination(path.join(vault, 'b.pdf'), vault), /not a real folder/);
    });
  });

  describe('moveToTrash', () => {
    it('moves the file, with its content, to a timestamped name', async () => {
      const file = await put('a/doc.pdf', 'content');
      const dest = await moveToTrash(file, vault);
      assert.equal(await exists(file), false);
      assert.match(path.basename(dest), /^doc_\d{13}\.pdf$/);
      assert.equal(path.dirname(dest), path.join(vault, '.trash'));
      assert.equal(await fs.readFile(dest, 'utf8'), 'content');
    });

    it('never overwrites: many files of one name trashed together all survive', async () => {
      const files = await Promise.all(Array.from({ length: 12 }, (_, i) => put(`dir${i}/same.md`, `content ${i}`)));
      await Promise.all(files.map(f => moveToTrash(f, vault)));
      const names = await fs.readdir(path.join(vault, '.trash'));
      assert.equal(names.length, 12);
      const contents = await Promise.all(names.map(n => fs.readFile(path.join(vault, '.trash', n), 'utf8')));
      assert.deepEqual(contents.sort(), Array.from({ length: 12 }, (_, i) => `content ${i}`).sort());
    });

    it('trashes a file whose name is too long to take the time as well', async () => {
      const file = await put(`${'n'.repeat(250)}.pdf`, 'long');
      const dest = await moveToTrash(file, vault);
      assert.equal(await fs.readFile(dest, 'utf8'), 'long');
    });

    it('leaves a link as a link, and the file it points at alone', async () => {
      const target = await put('target.txt', 'target');
      const link = path.join(vault, 'link.txt');
      await fs.symlink(target, link);
      const dest = await moveToTrash(link, vault);
      assert.ok((await fs.lstat(dest)).isSymbolicLink());
      assert.equal(await fs.readFile(target, 'utf8'), 'target');
    });

    it('fails, and keeps the file, when .trash is a link', async () => {
      await fs.mkdir(path.join(vault, 'elsewhere'));
      await fs.symlink(path.join(vault, 'elsewhere'), path.join(vault, '.trash'));
      const file = await put('keep.pdf');
      await assert.rejects(moveToTrash(file, vault), /not a real folder/);
      assert.equal(await exists(file), true);
      assert.deepEqual(await fs.readdir(path.join(vault, 'elsewhere')), []);
    });
  });

  describe('purgeTrash', () => {
    it('refuses a limit that is not a number above 0, and deletes nothing', async () => {
      const file = await put('.trash/a.pdf');
      for (const bad of [undefined, NaN, 0, -1, -0.5, Infinity, '30', null, true]) {
        await assert.rejects(purgeTrash({ vaultPath: vault, maxAgeDays: bad, now: Date.now() + 1000 * DAY }), /maxAgeDays must be a number above 0/, String(bad));
      }
      assert.equal(await exists(file), true);
    });

    it('does nothing when there is no .trash', async () => {
      assert.deepEqual(await purgeTrash({ vaultPath: vault, maxAgeDays: 30 }), { files: 0, bytes: 0, errors: 0 });
    });

    it('deletes files older than the limit by their ctime, keeps the others, and reports each', async () => {
      const old = await put('.trash/old.pdf', 'abcd');
      const removed = [];
      const ctime = (await fs.lstat(old)).ctimeMs;
      const keep = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: ctime + 30 * DAY });
      assert.equal(keep.files, 0, 'exactly at the limit is kept');
      const r = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: ctime + 31 * DAY, onRemoved: i => removed.push(i) });
      assert.deepEqual(r, { files: 1, bytes: 4, errors: 0 });
      assert.deepEqual(removed, [{ path: '.trash/old.pdf', bytes: 4, ageDays: 31 }]);
      assert.equal(await exists(old), false);
    });

    it('keeps a young file whatever its name says: a time in the name never makes it older', async () => {
      const fake = await put('.trash/IMG_1000000000000.jpg');
      const server = await put(`.trash/scan_${Date.now() - 900 * DAY}.pdf`);
      const r = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: await after(fake, 1) });
      assert.equal(r.files, 0);
      assert.equal(await exists(fake), true);
      assert.equal(await exists(server), true);
    });

    it('goes by the ctime, not the modification time', async () => {
      const file = await put('.trash/edited-long-ago.pdf');
      const long = new Date(Date.now() - 400 * DAY);
      await fs.utimes(file, long, long);
      await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: await after(file, 1) });
      assert.equal(await exists(file), true);
    });

    it('keeps a file whose age cannot be worked out', async () => {
      const file = await put('.trash/a.pdf');
      for (const now of [NaN, undefined]) {
        const r = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: now ?? NaN });
        assert.equal(r.files, 0);
      }
      assert.equal(await exists(file), true);
    });

    it('keeps the files of a folder that was moved into .trash recently, however old they are', async () => {
      const file = await put('Folder/deep/old-file.md');
      const ctime = (await fs.lstat(file)).ctimeMs;
      await sleep(150);
      await fs.mkdir(path.join(vault, '.trash'));
      await fs.rename(path.join(vault, 'Folder'), path.join(vault, '.trash', 'Folder')); // the folder's ctime is now later than its file's
      const trashed = path.join(vault, '.trash/Folder/deep/old-file.md');
      const limit = 0.001; // days: 86.4 seconds
      const r = await purgeTrash({ vaultPath: vault, maxAgeDays: limit, now: ctime + limit * DAY + 50 });
      assert.equal(r.files, 0, 'the file alone would be 50 ms past the limit');
      assert.equal(await exists(trashed), true);
      assert.equal((await purgeTrash({ vaultPath: vault, maxAgeDays: limit, now: Date.now() + 2 * limit * DAY })).files, 1);
    });

    it('removes the folders it empties, keeps a folder that holds a young file, and never .trash', async () => {
      const a = await put('.trash/sub/deep/a.pdf');
      const b = await put('.trash/keep/b.pdf');
      await sleep(40);
      const c = await put('.trash/young/c.pdf'); // trashed 40 ms after the others
      const newest = Math.max((await fs.lstat(a)).ctimeMs, (await fs.lstat(b)).ctimeMs);
      // The moment the first two are just over the limit and c, trashed later, is just under it.
      const r = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: newest + 30 * DAY + 5 });
      assert.equal(r.errors, 0);
      assert.equal(r.files, 2);
      assert.equal(await exists(path.join(vault, '.trash/sub')), false, 'the folder the purge emptied is gone');
      assert.equal(await exists(c), true, 'a young file stays');
      assert.equal(await exists(path.join(vault, '.trash/young')), true, 'so does the folder that holds it');
      assert.equal(await exists(path.join(vault, '.trash/keep')), false, 'while a folder whose only file is old goes with it');
      const empty = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: Date.now() + 1000 * DAY });
      assert.equal(empty.errors, 0);
      assert.equal(await exists(path.join(vault, '.trash')), true, '.trash stays when it is empty');
      assert.deepEqual(await fs.readdir(path.join(vault, '.trash')), []);
    });

    it('keeps an empty folder that is younger than the limit', async () => {
      await fs.mkdir(path.join(vault, '.trash/fresh'), { recursive: true });
      const ctime = (await fs.lstat(path.join(vault, '.trash/fresh'))).ctimeMs;
      await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: ctime + 29 * DAY });
      assert.equal(await exists(path.join(vault, '.trash/fresh')), true);
      await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: ctime + 31 * DAY });
      assert.equal(await exists(path.join(vault, '.trash/fresh')), false);
    });

    it('removes an old symbolic link as a link and never touches what it points at', async () => {
      const target = await put('outside/precious.txt', 'keep me');
      await fs.mkdir(path.join(vault, '.trash'));
      const link = path.join(vault, '.trash', 'link.txt');
      await fs.symlink(target, link);
      const folderLink = path.join(vault, '.trash', 'folder-link');
      await fs.symlink(path.join(vault, 'outside'), folderLink);
      const r = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: await after(link, 90) });
      assert.equal(r.errors, 0);
      assert.equal(await exists(link), false);
      assert.equal(await exists(folderLink), false);
      assert.equal(await fs.readFile(target, 'utf8'), 'keep me');
    });

    it('refuses a .trash that is a symbolic link, and a .trash that is a file', async () => {
      const victim = await put('elsewhere/victim.pdf');
      await fs.symlink(path.join(vault, 'elsewhere'), path.join(vault, '.trash'));
      await assert.rejects(purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: await after(victim, 90) }), /not a real folder/);
      assert.equal(await exists(victim), true);
      await fs.rm(path.join(vault, '.trash'));
      await fs.writeFile(path.join(vault, '.trash'), 'x');
      await assert.rejects(purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: Date.now() + 90 * DAY }), /not a real folder/);
    });

    it('does not follow a folder that is swapped for a link while the purge runs', async () => {
      const first = await put('.trash/dir/f1.pdf');
      await put('.trash/dir/f2.pdf');
      const out1 = await put('outside/f1.pdf', 'outside 1');
      const out2 = await put('outside/f2.pdf', 'outside 2');
      let swapped = false;
      const errors = [];
      const r = await purgeTrash({
        vaultPath: vault, maxAgeDays: 30, now: await after(first, 90),
        onRemoved: () => {
          // Called between two entries of the folder: swap the folder for a link to outside.
          if (swapped) return;
          swapped = true;
          fsSync.renameSync(path.join(vault, '.trash/dir'), path.join(vault, '.trash/dir-real'));
          fsSync.symlinkSync(path.join(vault, 'outside'), path.join(vault, '.trash/dir'));
        },
        onError: e => errors.push(e),
      });
      assert.equal(await fs.readFile(out1, 'utf8'), 'outside 1');
      assert.equal(await fs.readFile(out2, 'utf8'), 'outside 2');
      assert.equal(r.files, 1, 'only the file removed before the swap');
      assert.ok(r.errors >= 1 && errors.length >= 1, 'the rest is refused, not deleted through the link');
    });

    it('counts a failure on one entry and goes on with the rest', async (t) => {
      if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
      const stuck = await put('.trash/locked/stuck.pdf');
      const free = await put('.trash/free.pdf');
      await fs.chmod(path.join(vault, '.trash/locked'), 0o500);
      const errors = [];
      try {
        const r = await purgeTrash({ vaultPath: vault, maxAgeDays: 30, now: await after(stuck, 90), onError: e => errors.push(e) });
        assert.equal(r.files, 1);
        assert.equal(r.errors, 1);
        assert.equal(errors[0].path, '.trash/locked/stuck.pdf');
        assert.equal(await exists(free), false);
      } finally {
        await fs.chmod(path.join(vault, '.trash/locked'), 0o700);
      }
    });
  });

  describe('purgeVaults', () => {
    const reporters = () => {
      const seen = { audit: [], log: [], logErr: [] };
      return { seen, audit: (e, f) => seen.audit.push([e, f]), log: m => seen.log.push(m), logErr: m => seen.logErr.push(m) };
    };

    it('purges each vault by its own limit, skips a vault set to 0, and reports', async () => {
      const a = await put('a/.trash/old.pdf', '12345');
      await put('b/.trash/old.pdf');
      await put('c/.trash/old.pdf');
      const now = await after(a, 40);
      const r = reporters();
      await purgeVaults({
        a: { path: path.join(vault, 'a'), trashRetentionDays: 30 },
        b: { path: path.join(vault, 'b'), trashRetentionDays: 90 },
        c: { path: path.join(vault, 'c'), trashRetentionDays: 0 },
      }, r, now);
      assert.equal(await exists(path.join(vault, 'a/.trash/old.pdf')), false);
      assert.equal(await exists(path.join(vault, 'b/.trash/old.pdf')), true);
      assert.equal(await exists(path.join(vault, 'c/.trash/old.pdf')), true);
      assert.deepEqual(r.seen.audit, [
        ['trash-purged', { vault: 'a', path: '.trash/old.pdf', bytes: 5, age_days: 40 }],
        ['trash-purge', { vault: 'a', files: 1, bytes: 5, errors: 0 }],
      ]);
      assert.deepEqual(r.seen.log, [
        'trash purge of a: 1 file(s) older than 30 day(s) removed',
        'trash purge of b: 0 file(s) older than 90 day(s) removed',
      ]);
      assert.deepEqual(r.seen.logErr, []);
    });

    it('reports a vault it cannot purge and goes on with the others', async () => {
      await fs.mkdir(path.join(vault, 'bad/elsewhere'), { recursive: true });
      await fs.symlink(path.join(vault, 'bad/elsewhere'), path.join(vault, 'bad/.trash'));
      const good = await put('good/.trash/old.pdf');
      const r = reporters();
      await purgeVaults({
        bad: { path: path.join(vault, 'bad'), trashRetentionDays: 30 },
        good: { path: path.join(vault, 'good'), trashRetentionDays: 30 },
      }, r, await after(good, 40));
      assert.deepEqual(r.seen.logErr, ['trash purge of bad failed: .trash is not a real folder']);
      assert.equal(await exists(good), false);
    });
  });
});
