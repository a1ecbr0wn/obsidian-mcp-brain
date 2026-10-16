import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  isNoteFile,
  walkVault,
  readNote,
  writeNote,
  deleteNote,
  moveNote,
  searchContent,
  searchFilename,
  readBinaryFile,
  writeBinaryFile,
  deleteBinaryFile,
  moveBinaryFile,
  walkAllFiles,
  findBacklinks,
  resolveWikilink,
} from '../lib/vault.mjs';

// ── test vault setup ─────────────────────────────────────────────────────────

let vault;

async function setup() {
  vault = await fs.mkdtemp(path.join(tmpdir(), 'vault-test-'));
  await fs.mkdir(path.join(vault, 'food'));
  await fs.mkdir(path.join(vault, 'private'));
  await fs.writeFile(path.join(vault, 'food', 'pasta.md'), `---\ntags: [cooking]\n---\n# Pasta\n\nSee [[sauce]] for the sauce recipe.\n`);
  await fs.writeFile(path.join(vault, 'food', 'sauce.md'), `---\ntags: [cooking]\n---\n# Sauce\n\nA tomato sauce.\n`);
  await fs.writeFile(path.join(vault, 'private', 'journal.md'), `# Journal\n\nPrivate notes.\n`);
  await fs.writeFile(path.join(vault, 'inbox.md'), `# Inbox\n\nLinks: [[pasta]] and [[private/journal]].\n`);
}

async function teardown() {
  await fs.rm(vault, { recursive: true });
}

// ── walkVault ─────────────────────────────────────────────────────────────────

describe('walkVault', () => {
  before(setup);
  after(teardown);

  it('visits all .md files recursively', async () => {
    const visited = [];
    await walkVault(vault, f => visited.push(path.relative(vault, f)));
    visited.sort();
    assert.deepEqual(visited, ['food/pasta.md', 'food/sauce.md', 'inbox.md', 'private/journal.md']);
  });

  it('visits files in a subdirectory', async () => {
    const visited = [];
    await walkVault(path.join(vault, 'food'), f => visited.push(path.relative(vault, f)));
    visited.sort();
    assert.deepEqual(visited, ['food/pasta.md', 'food/sauce.md']);
  });

  it('handles non-existent directory gracefully', async () => {
    await assert.doesNotReject(() => walkVault(path.join(vault, 'missing'), () => {}));
  });

  it('treats an upper-case or mixed-case .md extension as a note', async () => {
    await fs.writeFile(path.join(vault, 'SHOUT.MD'), '# Shout\n');
    await fs.writeFile(path.join(vault, 'Mixed.Md'), '# Mixed\n');
    const visited = [];
    await walkVault(vault, f => visited.push(path.relative(vault, f)));
    await fs.rm(path.join(vault, 'SHOUT.MD'));
    await fs.rm(path.join(vault, 'Mixed.Md'));
    assert.ok(visited.includes('SHOUT.MD'));
    assert.ok(visited.includes('Mixed.Md'));
  });
});

// ── isNoteFile ────────────────────────────────────────────────────────────────

describe('isNoteFile', () => {
  it('is true for .md in any case', () => {
    for (const n of ['a.md', 'A.MD', 'a.Md', 'dir/sub/a.md', 'two.words.md']) {
      assert.equal(isNoteFile(n), true, n);
    }
  });

  it('is false for everything else', () => {
    for (const n of ['a.pdf', 'a.md.bak', 'md', 'a.mdx', 'amd', 'a.markdown', '', 'a.md/']) {
      assert.equal(isNoteFile(n), false, n);
    }
  });
});

// ── readNote ──────────────────────────────────────────────────────────────────

describe('readNote', () => {
  before(setup);
  after(teardown);

  it('reads note content', async () => {
    const content = await readNote(path.join(vault, 'food', 'pasta.md'));
    assert.ok(content.includes('# Pasta'));
  });

  it('throws on missing file', async () => {
    await assert.rejects(() => readNote(path.join(vault, 'missing.md')));
  });
});

// ── writeNote ─────────────────────────────────────────────────────────────────

describe('writeNote', () => {
  before(setup);
  after(teardown);

  it('writes note content', async () => {
    const p = path.join(vault, 'food', 'new.md');
    await writeNote(p, '# New Note\n');
    const content = await fs.readFile(p, 'utf8');
    assert.equal(content, '# New Note\n');
  });

  it('creates parent directories', async () => {
    const p = path.join(vault, 'deep', 'nested', 'note.md');
    await writeNote(p, '# Deep\n');
    const content = await fs.readFile(p, 'utf8');
    assert.equal(content, '# Deep\n');
  });

  it('overwrites existing file', async () => {
    const p = path.join(vault, 'food', 'pasta.md');
    await writeNote(p, '# Updated\n');
    const content = await fs.readFile(p, 'utf8');
    assert.equal(content, '# Updated\n');
  });
});

// ── deleteNote ────────────────────────────────────────────────────────────────

describe('deleteNote', () => {
  before(setup);
  after(teardown);

  it('moves note to .trash (default)', async () => {
    // Create a note to delete
    const p = path.join(vault, 'to-delete.md');
    await fs.writeFile(p, '# Delete me\n');
    await deleteNote(p, false, vault);
    // File should be gone from original location
    await assert.rejects(() => fs.access(p));
    // Should exist in .trash
    const trashed = path.join(vault, '.trash', 'to-delete.md');
    await assert.doesNotReject(() => fs.access(trashed));
  });

  it('deletes note permanently', async () => {
    const p = path.join(vault, 'to-delete-perm.md');
    await fs.writeFile(p, '# Delete me permanently\n');
    await deleteNote(p, true, vault);
    await assert.rejects(() => fs.access(p));
    // Should NOT be in .trash
    const trashed = path.join(vault, '.trash', 'to-delete-perm.md');
    await assert.rejects(() => fs.access(trashed));
  });

  it('keeps the original extension when a trashed .MD note collides', async () => {
    const p = path.join(vault, 'Dup.MD');
    await fs.writeFile(p, '# one\n');
    await deleteNote(p, false, vault);
    await fs.writeFile(p, '# two\n');
    await deleteNote(p, false, vault);
    const trash = (await fs.readdir(path.join(vault, '.trash'))).filter(n => n.startsWith('Dup'));
    assert.equal(trash.length, 2);
    assert.ok(trash.includes('Dup.MD'));
    assert.ok(trash.some(n => /^Dup_\d+\.MD$/.test(n)), trash.join(', '));
  });
});

// ── moveNote ──────────────────────────────────────────────────────────────────

describe('moveNote', () => {
  before(setup);
  after(teardown);

  it('moves note to new location', async () => {
    const src = path.join(vault, 'food', 'sauce.md');
    const dst = path.join(vault, 'cooking', 'sauce.md');
    await moveNote(vault, src, dst, []);
    await assert.rejects(() => fs.access(src), 'source removed');
    await assert.doesNotReject(() => fs.access(dst), 'destination created');
  });

  it('rewrites wikilinks in other notes after move', async () => {
    // inbox.md has [[pasta]] — move pasta.md to cooking/pasta.md
    // Reset setup for clean state
    await fs.writeFile(path.join(vault, 'inbox.md'), `# Inbox\n\nLinks: [[pasta]] and [[private/journal]].\n`);
    await fs.mkdir(path.join(vault, 'food'), { recursive: true });
    await fs.writeFile(path.join(vault, 'food', 'pasta.md'), `---\ntags: [cooking]\n---\n# Pasta\n`);

    const src = path.join(vault, 'food', 'pasta.md');
    const dst = path.join(vault, 'cooking', 'pasta.md');
    await moveNote(vault, src, dst, []);

    const inbox = await fs.readFile(path.join(vault, 'inbox.md'), 'utf8');
    assert.ok(inbox.includes('[[cooking/pasta]]'), 'link rewritten');
    assert.ok(!inbox.includes('[[pasta]]') || inbox.includes('[[cooking/pasta]]'), 'old link gone');
  });

  it('creates destination directory if needed', async () => {
    await fs.writeFile(path.join(vault, 'new-note.md'), '# New\n');
    const src = path.join(vault, 'new-note.md');
    const dst = path.join(vault, 'archive', 'new-note.md');
    await moveNote(vault, src, dst, []);
    await assert.doesNotReject(() => fs.access(dst));
  });

  it('rewrites links to a .MD note, as Obsidian resolves [[Foo]] to Foo.MD', async () => {
    await fs.writeFile(path.join(vault, 'Foo.MD'), '# Foo\n');
    await fs.writeFile(path.join(vault, 'refs-foo.md'), 'See [[Foo]] and [[Foo|alias]].\n');
    await moveNote(vault, path.join(vault, 'Foo.MD'), path.join(vault, 'sub', 'Bar.MD'), []);
    const refs = await fs.readFile(path.join(vault, 'refs-foo.md'), 'utf8');
    assert.equal(refs, 'See [[sub/Bar]] and [[sub/Bar|alias]].\n');
  });
});

// ── readBinaryFile / writeBinaryFile ─────────────────────────────────────────

describe('readBinaryFile', () => {
  before(setup);
  after(teardown);

  it('reads binary content as a Buffer', async () => {
    const p = path.join(vault, 'image.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await fs.writeFile(p, bytes);
    const content = await readBinaryFile(p);
    assert.ok(Buffer.isBuffer(content));
    assert.deepEqual(content, bytes);
  });

  it('throws on missing file', async () => {
    await assert.rejects(() => readBinaryFile(path.join(vault, 'missing.png')));
  });
});

describe('writeBinaryFile', () => {
  before(setup);
  after(teardown);

  it('writes binary content', async () => {
    const p = path.join(vault, 'attachments', 'photo.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff]);
    await writeBinaryFile(p, bytes);
    const content = await fs.readFile(p);
    assert.deepEqual(content, bytes);
  });

  it('creates parent directories', async () => {
    const p = path.join(vault, 'deep', 'nested', 'image.png');
    const bytes = Buffer.from([0x01, 0x02]);
    await writeBinaryFile(p, bytes);
    const content = await fs.readFile(p);
    assert.deepEqual(content, bytes);
  });

  it('overwrites existing file', async () => {
    const p = path.join(vault, 'overwrite.png');
    await writeBinaryFile(p, Buffer.from([0x01]));
    await writeBinaryFile(p, Buffer.from([0x02]));
    const content = await fs.readFile(p);
    assert.deepEqual(content, Buffer.from([0x02]));
  });
});

// ── deleteBinaryFile ──────────────────────────────────────────────────────────

describe('deleteBinaryFile', () => {
  before(setup);
  after(teardown);

  it('moves binary file to .trash (default), keeping its extension', async () => {
    const p = path.join(vault, 'to-delete.png');
    await fs.writeFile(p, Buffer.from([0x01]));
    await deleteBinaryFile(p, false, vault);
    await assert.rejects(() => fs.access(p));
    const trashed = path.join(vault, '.trash', 'to-delete.png');
    await assert.doesNotReject(() => fs.access(trashed));
  });

  it('deletes binary file permanently', async () => {
    const p = path.join(vault, 'to-delete-perm.png');
    await fs.writeFile(p, Buffer.from([0x01]));
    await deleteBinaryFile(p, true, vault);
    await assert.rejects(() => fs.access(p));
    const trashed = path.join(vault, '.trash', 'to-delete-perm.png');
    await assert.rejects(() => fs.access(trashed));
  });

  it('suffixes with a timestamp on collision, preserving the extension', async () => {
    const p1 = path.join(vault, 'dup.png');
    await fs.writeFile(p1, Buffer.from([0x01]));
    await deleteBinaryFile(p1, false, vault); // now in .trash/dup.png

    const p2 = path.join(vault, 'dup.png');
    await fs.writeFile(p2, Buffer.from([0x02]));
    await deleteBinaryFile(p2, false, vault);

    const trashEntries = await fs.readdir(path.join(vault, '.trash'));
    const dupEntries = trashEntries.filter(e => e.startsWith('dup'));
    assert.equal(dupEntries.length, 2);
    assert.ok(dupEntries.every(e => e.endsWith('.png')));
  });
});

// ── moveBinaryFile ────────────────────────────────────────────────────────────

describe('moveBinaryFile', () => {
  before(setup);
  after(teardown);

  it('moves binary file to new location', async () => {
    const src = path.join(vault, 'photo.png');
    await fs.writeFile(src, Buffer.from([0x01]));
    const dst = path.join(vault, 'attachments', 'photo.png');
    await moveBinaryFile(vault, src, dst, []);
    await assert.rejects(() => fs.access(src), 'source removed');
    await assert.doesNotReject(() => fs.access(dst), 'destination created');
  });

  it('rewrites wikilink embeds in other notes after move', async () => {
    await fs.writeFile(path.join(vault, 'diagram.png'), Buffer.from([0x01]));
    await fs.writeFile(path.join(vault, 'note-with-embed.md'), 'See ![[diagram.png]] below.\n');

    const src = path.join(vault, 'diagram.png');
    const dst = path.join(vault, 'img', 'diagram.png');
    await moveBinaryFile(vault, src, dst, []);

    const note = await fs.readFile(path.join(vault, 'note-with-embed.md'), 'utf8');
    assert.ok(note.includes('![[img/diagram.png]]'), 'embed rewritten');
  });

  it('throws if destination already exists', async () => {
    const src = path.join(vault, 'a.png');
    const dst = path.join(vault, 'b.png');
    await fs.writeFile(src, Buffer.from([0x01]));
    await fs.writeFile(dst, Buffer.from([0x02]));
    await assert.rejects(() => moveBinaryFile(vault, src, dst, []));
  });

  it('creates destination directory if needed', async () => {
    const src = path.join(vault, 'new-image.png');
    await fs.writeFile(src, Buffer.from([0x01]));
    const dst = path.join(vault, 'brand-new-folder', 'new-image.png');
    await moveBinaryFile(vault, src, dst, []);
    await assert.doesNotReject(() => fs.access(dst));
  });
});

// ── walkAllFiles ──────────────────────────────────────────────────────────────

describe('walkAllFiles', () => {
  before(async () => {
    await setup();
    await fs.writeFile(path.join(vault, 'food', 'photo.png'), Buffer.from([0x01]));
  });
  after(teardown);

  it('visits both markdown and binary files', async () => {
    const visited = [];
    await walkAllFiles(vault, f => visited.push(path.relative(vault, f)));
    visited.sort();
    assert.deepEqual(visited, [
      'food/pasta.md', 'food/photo.png', 'food/sauce.md', 'inbox.md', 'private/journal.md',
    ]);
  });

  it('handles non-existent directory gracefully', async () => {
    await assert.doesNotReject(() => walkAllFiles(path.join(vault, 'missing'), () => {}));
  });
});

// ── findBacklinks ─────────────────────────────────────────────────────────────

describe('findBacklinks', () => {
  before(setup);
  after(teardown);

  it('finds notes linking to a note by bare basename', async () => {
    // food/pasta.md links [[sauce]], which matches food/sauce.md by basename
    const results = await findBacklinks(vault, 'food/sauce.md', []);
    assert.deepEqual(results, ['food/pasta.md']);
  });

  it('finds notes linking to a note by full path', async () => {
    // inbox.md links [[private/journal]]
    const results = await findBacklinks(vault, 'private/journal.md', []);
    assert.deepEqual(results, ['inbox.md']);
  });

  it('finds embeds referencing a binary file', async () => {
    await fs.writeFile(path.join(vault, 'food', 'diagram.png'), Buffer.from([0x01]));
    await fs.writeFile(path.join(vault, 'notes-with-embed.md'), 'See ![[diagram.png]] below.\n');
    const results = await findBacklinks(vault, 'food/diagram.png', []);
    assert.deepEqual(results, ['notes-with-embed.md']);
  });

  it('does not include the target itself', async () => {
    await fs.writeFile(path.join(vault, 'self-ref.md'), 'See [[self-ref]] (itself).\n');
    const results = await findBacklinks(vault, 'self-ref.md', []);
    assert.deepEqual(results, []);
  });

  it('returns empty array when nothing links to the target', async () => {
    await fs.writeFile(path.join(vault, 'lonely.md'), '# Lonely\n');
    const results = await findBacklinks(vault, 'lonely.md', []);
    assert.deepEqual(results, []);
  });

  it('excludes denied notes from the results', async () => {
    await fs.writeFile(path.join(vault, 'private', 'refs-sauce.md'), 'See [[sauce]].\n');
    const results = await findBacklinks(vault, 'food/sauce.md', ['private']);
    assert.ok(!results.includes('private/refs-sauce.md'));
  });

  it('finds notes linking to a .MD note by its extensionless name', async () => {
    await fs.writeFile(path.join(vault, 'Upper.MD'), '# Upper\n');
    await fs.writeFile(path.join(vault, 'links-upper.md'), 'See [[Upper]].\n');
    const results = await findBacklinks(vault, 'Upper.MD', []);
    assert.deepEqual(results, ['links-upper.md']);
  });

  it('walks a .MD note for links of its own', async () => {
    await fs.writeFile(path.join(vault, 'Linker.MD'), 'See [[sauce]].\n');
    const results = await findBacklinks(vault, 'food/sauce.md', []);
    assert.ok(results.includes('Linker.MD'), results.join(', '));
  });
});

// ── resolveWikilink ───────────────────────────────────────────────────────────

describe('resolveWikilink', () => {
  before(async () => {
    await setup();
    await fs.writeFile(path.join(vault, 'food', 'photo.png'), Buffer.from([0x01]));
  });
  after(teardown);

  it('resolves a bare basename to its full path', async () => {
    const results = await resolveWikilink(vault, 'sauce', []);
    assert.deepEqual(results, ['food/sauce.md']);
  });

  it('resolves a full path target', async () => {
    const results = await resolveWikilink(vault, 'private/journal', []);
    assert.deepEqual(results, ['private/journal.md']);
  });

  it('resolves a binary file target with its extension', async () => {
    const results = await resolveWikilink(vault, 'photo.png', []);
    assert.deepEqual(results, ['food/photo.png']);
  });

  it('returns empty array when nothing resolves', async () => {
    const results = await resolveWikilink(vault, 'no-such-file', []);
    assert.deepEqual(results, []);
  });

  it('returns multiple matches when the basename is ambiguous', async () => {
    await fs.mkdir(path.join(vault, 'other'), { recursive: true });
    await fs.writeFile(path.join(vault, 'other', 'sauce.md'), '# Other Sauce\n');
    const results = await resolveWikilink(vault, 'sauce', []);
    assert.deepEqual(results, ['food/sauce.md', 'other/sauce.md']);
  });

  it('resolves an extensionless link to a .MD note', async () => {
    await fs.writeFile(path.join(vault, 'Shout.MD'), '# Shout\n');
    assert.deepEqual(await resolveWikilink(vault, 'Shout', []), ['Shout.MD']);
  });

  it('reports x.md and x.MD together as ambiguous', async () => {
    await fs.writeFile(path.join(vault, 'twin.md'), '# a\n');
    await fs.writeFile(path.join(vault, 'twin.MD'), '# b\n');
    const results = await resolveWikilink(vault, 'twin', []);
    assert.equal(results.length, 2, results.join(', '));
  });

  it('excludes denied files from the results', async () => {
    const results = await resolveWikilink(vault, 'journal', ['private']);
    assert.deepEqual(results, []);
  });
});

// ── searchContent ─────────────────────────────────────────────────────────────

describe('searchContent', () => {
  before(setup);
  after(teardown);

  it('finds notes containing query', async () => {
    const results = await searchContent(vault, 'tomato', vault, []);
    const paths = results.map(r => r.path);
    assert.ok(paths.some(p => p.includes('sauce')), 'sauce.md found');
  });

  it('returns the text of a line in a CRLF note without its carriage return, with the right line number', async () => {
    await fs.writeFile(path.join(vault, 'crlf.md'), '# Win\r\nfirst\r\nneedle-crlf here\r\nlast\r\n');
    const results = await searchContent(vault, 'needle-crlf', vault, []);
    assert.deepEqual(results, [{ path: 'crlf.md', matches: [{ line: 3, text: 'needle-crlf here' }] }]);
    await fs.rm(path.join(vault, 'crlf.md'));
  });

  it('is case-insensitive', async () => {
    const results = await searchContent(vault, 'TOMATO', vault, []);
    assert.ok(results.length > 0);
  });

  it('returns empty array when no matches', async () => {
    const results = await searchContent(vault, 'xyzzy-no-match', vault, []);
    assert.deepEqual(results, []);
  });

  it('scopes search to subdirectory', async () => {
    const results = await searchContent(vault, 'Private', path.join(vault, 'food'), []);
    assert.equal(results.length, 0, 'private not in food scope');
  });

  it('excludes denied paths', async () => {
    const results = await searchContent(vault, 'Private', vault, ['private']);
    const paths = results.map(r => r.path);
    assert.ok(!paths.some(p => p.includes('private')));
  });

  it('includes matching line with line number in result', async () => {
    const results = await searchContent(vault, 'tomato', vault, []);
    const sauce = results.find(r => r.path.includes('sauce'));
    assert.ok(sauce?.matches?.length > 0);
    assert.ok(typeof sauce.matches[0].line === 'number');
    assert.ok(sauce.matches[0].text.toLowerCase().includes('tomato'));
  });
});

// ── searchFilename ────────────────────────────────────────────────────────────

describe('searchFilename', () => {
  before(setup);
  after(teardown);

  it('finds notes by filename', async () => {
    const results = await searchFilename(vault, 'pasta', vault, []);
    assert.ok(results.some(p => p.includes('pasta')));
  });

  it('is case-insensitive', async () => {
    const results = await searchFilename(vault, 'PASTA', vault, []);
    assert.ok(results.length > 0);
  });

  it('returns empty array when no matches', async () => {
    const results = await searchFilename(vault, 'xyzzy-no-match', vault, []);
    assert.deepEqual(results, []);
  });

  it('scopes search to subdirectory', async () => {
    const results = await searchFilename(vault, 'journal', path.join(vault, 'food'), []);
    assert.equal(results.length, 0);
  });

  it('excludes denied paths', async () => {
    const results = await searchFilename(vault, 'journal', vault, ['private']);
    assert.equal(results.length, 0);
  });

  it('returns vault-relative paths', async () => {
    const results = await searchFilename(vault, 'pasta', vault, []);
    assert.ok(results.every(p => !path.isAbsolute(p)));
  });
});
