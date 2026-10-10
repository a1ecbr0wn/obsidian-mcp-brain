import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normPath, isDenied, checkAccess, compileBinaryPatterns, isBinaryReadDenied, checkBinaryMove } from '../lib/access.mjs';

const DENY = ['people', 'private/journal'];

// ── normPath ────────────────────────────────────────────────────────────────

describe('normPath', () => {
  it('joins folder and filename', () => {
    assert.equal(normPath('people', 'alice.md'), 'people/alice.md');
  });

  it('strips leading and trailing slashes', () => {
    assert.equal(normPath('/people/alice/'), 'people/alice');
  });

  it('collapses multiple slashes', () => {
    assert.equal(normPath('people//alice'), 'people/alice');
  });

  it('resolves .. segments', () => {
    assert.equal(normPath('people/../notes/foo.md'), 'notes/foo.md');
  });

  it('cannot escape above root via ..', () => {
    assert.equal(normPath('../../etc/passwd'), 'etc/passwd');
  });

  it('ignores . segments', () => {
    assert.equal(normPath('./people/./alice.md'), 'people/alice.md');
  });

  it('filters falsy parts', () => {
    assert.equal(normPath(undefined, 'alice.md'), 'alice.md');
    assert.equal(normPath('', 'alice.md'), 'alice.md');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normPath(''), '');
    assert.equal(normPath(), '');
  });
});

// ── isDenied ────────────────────────────────────────────────────────────────

describe('isDenied', () => {
  it('blocks exact match on denied path', () => {
    assert.ok(isDenied(DENY, 'people'));
  });

  it('blocks paths under denied prefix', () => {
    assert.ok(isDenied(DENY, 'people/alice.md'));
    assert.ok(isDenied(DENY, 'people/subdir/note.md'));
  });

  it('does not block sibling that shares prefix characters', () => {
    assert.ok(!isDenied(DENY, 'people-extra'));
    assert.ok(!isDenied(DENY, 'peoples'));
  });

  it('blocks nested deny path', () => {
    assert.ok(isDenied(DENY, 'private/journal'));
    assert.ok(isDenied(DENY, 'private/journal/2024.md'));
  });

  it('does not block sibling of nested deny path', () => {
    assert.ok(!isDenied(DENY, 'private/notes'));
  });

  it('does not block allowed paths', () => {
    assert.ok(!isDenied(DENY, 'projects/alpha.md'));
    assert.ok(!isDenied(DENY, 'inbox'));
  });

  it('returns false when deny list is empty', () => {
    assert.ok(!isDenied([], 'people/alice.md'));
  });

  it('returns false for empty path', () => {
    assert.ok(!isDenied(DENY, ''));
    assert.ok(!isDenied(DENY, null));
    assert.ok(!isDenied(DENY, undefined));
  });

  it('normalises path before checking', () => {
    assert.ok(isDenied(DENY, '/people/../people/alice.md'));
    assert.ok(isDenied(DENY, '//people//alice.md'));
  });
});

// ── checkAccess ─────────────────────────────────────────────────────────────

describe('checkAccess', () => {
  it('returns null when deny list is empty', () => {
    assert.equal(checkAccess([], 'read-note', { folder: 'people', filename: 'alice.md' }), null);
  });

  it('returns null for unrecognised tool', () => {
    assert.equal(checkAccess(DENY, 'list-vaults', {}), null);
  });

  describe('read-note / create-note / edit-note', () => {
    it('blocks denied folder', () => {
      const r = checkAccess(DENY, 'read-note', { folder: 'people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted folder', () => {
      assert.equal(checkAccess(DENY, 'read-note', { folder: 'projects', filename: 'alpha.md' }), null);
    });

    it('blocks via .. traversal into denied folder', () => {
      const r = checkAccess(DENY, 'edit-note', { folder: 'projects/../people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('handles missing folder (filename only)', () => {
      assert.equal(checkAccess(DENY, 'create-note', { filename: 'inbox.md' }), null);
    });
  });

  describe('delete-note', () => {
    it('blocks denied path', () => {
      const r = checkAccess(DENY, 'delete-note', { folder: 'people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted path', () => {
      assert.equal(checkAccess(DENY, 'delete-note', { folder: 'inbox', filename: 'todo.md' }), null);
    });

    it('reflects normalised path in message, not raw input', () => {
      const r = checkAccess(DENY, 'delete-note', { folder: '//people', filename: 'alice.md' });
      assert.ok(r?.includes("'people/alice.md'"));
      assert.ok(!r?.includes('//'));
    });

    it('handles missing folder (filename only)', () => {
      assert.equal(checkAccess(DENY, 'delete-note', { filename: 'inbox.md' }), null);
    });
  });

  describe('move-note', () => {
    it('blocks denied source', () => {
      const r = checkAccess(DENY, 'move-note', { folder: 'people', filename: 'alice.md', newFilename: 'alice.md' });
      assert.ok(r?.includes('source'));
    });

    it('blocks denied destination', () => {
      const r = checkAccess(DENY, 'move-note', { filename: 'alice.md', newFolder: 'people', newFilename: 'alice.md' });
      assert.ok(r?.includes('destination'));
    });

    it('allows permitted source and destination', () => {
      assert.equal(checkAccess(DENY, 'move-note', { filename: 'a.md', newFolder: 'projects', newFilename: 'a.md' }), null);
    });

    it('allows when source has no folder (root-level file)', () => {
      assert.equal(checkAccess(DENY, 'move-note', { filename: 'inbox.md', newFolder: 'projects', newFilename: 'inbox.md' }), null);
    });

    it('allows when destination has no folder (root-level destination)', () => {
      assert.equal(checkAccess(DENY, 'move-note', { folder: 'projects', filename: 'a.md', newFilename: 'a.md' }), null);
    });
  });

  describe('create-binary-file / delete-binary-file', () => {
    it('blocks denied path', () => {
      const r1 = checkAccess(DENY, 'create-binary-file', { folder: 'people', filename: 'photo.png' });
      assert.ok(r1?.includes('restricted'));
      const r2 = checkAccess(DENY, 'delete-binary-file', { folder: 'people', filename: 'photo.png' });
      assert.ok(r2?.includes('restricted'));
    });

    it('allows permitted path', () => {
      assert.equal(checkAccess(DENY, 'create-binary-file', { folder: 'projects', filename: 'photo.png' }), null);
      assert.equal(checkAccess(DENY, 'delete-binary-file', { folder: 'projects', filename: 'photo.png' }), null);
    });

    it('handles missing folder (filename only)', () => {
      assert.equal(checkAccess(DENY, 'create-binary-file', { filename: 'photo.png' }), null);
      assert.equal(checkAccess(DENY, 'delete-binary-file', { filename: 'photo.png' }), null);
    });
  });

  describe('move-binary-file', () => {
    it('blocks denied source', () => {
      const r = checkAccess(DENY, 'move-binary-file', { folder: 'people', filename: 'photo.png', newFilename: 'photo.png' });
      assert.ok(r?.includes('source'));
    });

    it('blocks denied destination', () => {
      const r = checkAccess(DENY, 'move-binary-file', { filename: 'photo.png', newFolder: 'people', newFilename: 'photo.png' });
      assert.ok(r?.includes('destination'));
    });

    it('allows permitted source and destination', () => {
      assert.equal(checkAccess(DENY, 'move-binary-file', { filename: 'a.png', newFolder: 'projects', newFilename: 'a.png' }), null);
    });
  });

  describe('find-backlinks', () => {
    it('blocks denied target path', () => {
      const r = checkAccess(DENY, 'find-backlinks', { folder: 'people', filename: 'alice.md' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted target path', () => {
      assert.equal(checkAccess(DENY, 'find-backlinks', { folder: 'projects', filename: 'alpha.md' }), null);
    });

    it('handles missing folder (filename only)', () => {
      assert.equal(checkAccess(DENY, 'find-backlinks', { filename: 'inbox.md' }), null);
    });
  });

  describe('resolve-wikilink', () => {
    it('blocks a target string that itself looks like a denied path', () => {
      const r = checkAccess(DENY, 'resolve-wikilink', { target: 'people/alice' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows a permitted target string', () => {
      assert.equal(checkAccess(DENY, 'resolve-wikilink', { target: 'projects/alpha' }), null);
    });

    it('allows a bare basename target', () => {
      assert.equal(checkAccess(DENY, 'resolve-wikilink', { target: 'alpha' }), null);
    });

    it('handles missing target gracefully', () => {
      assert.equal(checkAccess(DENY, 'resolve-wikilink', {}), null);
    });
  });

  describe('add-tags / remove-tags', () => {
    it('blocks when any file is in denied path', () => {
      const r = checkAccess(DENY, 'add-tags', { files: ['inbox/a.md', 'people/alice.md'] });
      assert.ok(r?.includes('restricted'));
    });

    it('allows when all files are permitted', () => {
      assert.equal(checkAccess(DENY, 'add-tags', { files: ['inbox/a.md', 'projects/b.md'] }), null);
    });

    it('handles non-array files gracefully', () => {
      assert.equal(checkAccess(DENY, 'add-tags', { files: 'people/alice.md' }), null);
      assert.equal(checkAccess(DENY, 'add-tags', {}), null);
    });

    it('handles empty files array', () => {
      assert.equal(checkAccess(DENY, 'remove-tags', { files: [] }), null);
    });
  });

  describe('create-folder', () => {
    it('blocks denied path', () => {
      const r = checkAccess(DENY, 'create-folder', { folder: 'people/new' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted path', () => {
      assert.equal(checkAccess(DENY, 'create-folder', { folder: 'projects/new' }), null);
    });

    it('blocks .. traversal into denied path', () => {
      const r = checkAccess(DENY, 'create-folder', { folder: 'projects/../people/new' });
      assert.ok(r?.includes('restricted'));
    });
  });

  describe('search-vault', () => {
    it('blocks denied path scope', () => {
      const r = checkAccess(DENY, 'search-vault', { query: 'foo', path: 'people' });
      assert.ok(r?.includes('restricted'));
    });

    it('allows permitted path scope', () => {
      assert.equal(checkAccess(DENY, 'search-vault', { query: 'foo', path: 'projects' }), null);
    });

    it('allows vault-wide search with no path', () => {
      assert.equal(checkAccess(DENY, 'search-vault', { query: 'foo' }), null);
    });
  });
});

// ── denyBinaryPaths ─────────────────────────────────────────────────────────

const protectedBy = (patterns, p) => isBinaryReadDenied(compileBinaryPatterns(patterns), p);

describe('isBinaryReadDenied', () => {
  it('protects nothing when the list is empty', () => {
    assert.equal(protectedBy([], 'scans/a.pdf'), false);
  });

  it('never protects the empty path', () => {
    assert.equal(protectedBy(['**'], ''), false);
  });

  it('matches an exact file path', () => {
    assert.equal(protectedBy(['scans/a.pdf'], 'scans/a.pdf'), true);
    assert.equal(protectedBy(['scans/a.pdf'], 'scans/b.pdf'), false);
  });

  it('matches everything under a folder, but not a sibling that shares the prefix', () => {
    assert.equal(protectedBy(['scans'], 'scans/a.pdf'), true);
    assert.equal(protectedBy(['scans'], 'scans/2026/deep/a.pdf'), true);
    assert.equal(protectedBy(['scans'], 'scans-old/a.pdf'), false);
    assert.equal(protectedBy(['scans'], 'other/scans.pdf'), false);
  });

  it('* matches within one segment only', () => {
    assert.equal(protectedBy(['scans/*.pdf'], 'scans/a.pdf'), true);
    assert.equal(protectedBy(['scans/*.pdf'], 'scans/sub/a.pdf'), false);
    assert.equal(protectedBy(['scans/*.pdf'], 'scans/a.png'), false);
  });

  it('* can match zero characters and a mid-name run', () => {
    assert.equal(protectedBy(['a*b.pdf'], 'ab.pdf'), true);
    assert.equal(protectedBy(['a*b.pdf'], 'aXYZb.pdf'), true);
    assert.equal(protectedBy(['a*b.pdf'], 'aXYZc.pdf'), false);
  });

  it('? matches exactly one character within a segment', () => {
    assert.equal(protectedBy(['scan?.pdf'], 'scan1.pdf'), true);
    assert.equal(protectedBy(['scan?.pdf'], 'scan.pdf'), false);
    assert.equal(protectedBy(['scan?.pdf'], 'scan12.pdf'), false);
    assert.equal(protectedBy(['a?b'], 'a/b'), false);
  });

  it('* as a mid-path segment matches exactly one folder level', () => {
    assert.equal(protectedBy(['*/scans'], 'a/scans/x.pdf'), true);
    assert.equal(protectedBy(['*/scans'], 'scans/x.pdf'), false);
    assert.equal(protectedBy(['*/scans'], 'a/b/scans/x.pdf'), false);
  });

  it('** matches any number of whole segments, including none', () => {
    assert.equal(protectedBy(['**/*.pdf'], 'a.pdf'), true);
    assert.equal(protectedBy(['**/*.pdf'], 'a/b/c/a.pdf'), true);
    assert.equal(protectedBy(['**/*.pdf'], 'a/b/c/a.png'), false);
    assert.equal(protectedBy(['a/**/z.pdf'], 'a/z.pdf'), true);
    assert.equal(protectedBy(['a/**/z.pdf'], 'a/b/c/z.pdf'), true);
    assert.equal(protectedBy(['a/**/z.pdf'], 'b/a/z.pdf'), false);
  });

  it('a trailing ** protects everything beneath the folder', () => {
    assert.equal(protectedBy(['private/**'], 'private/a.pdf'), true);
    assert.equal(protectedBy(['private/**'], 'private/x/y/a.pdf'), true);
    assert.equal(protectedBy(['private/**'], 'public/a.pdf'), false);
  });

  it('a lone ** protects everything', () => {
    assert.equal(protectedBy(['**'], 'any/where/a.pdf'), true);
  });

  it('** inside a segment behaves like a single *', () => {
    assert.equal(protectedBy(['a**b.pdf'], 'aXb.pdf'), true);
    assert.equal(protectedBy(['a**b.pdf'], 'a/x/b.pdf'), false);
  });

  it('wildcards match dotfiles and dot folders', () => {
    assert.equal(protectedBy(['*.pdf'], '.hidden.pdf'), true);
    assert.equal(protectedBy(['**/*.pdf'], '.obsidian/x.pdf'), true);
  });

  it('is case-sensitive', () => {
    assert.equal(protectedBy(['scans/*.pdf'], 'scans/A.PDF'), false);
    assert.equal(protectedBy(['Scans'], 'scans/a.pdf'), false);
  });

  it('treats regular-expression characters in a pattern literally', () => {
    assert.equal(protectedBy(['a.b(1)+[x]$^|{y}.pdf'], 'a.b(1)+[x]$^|{y}.pdf'), true);
    assert.equal(protectedBy(['a.pdf'], 'aXpdf'), false);
    assert.equal(protectedBy(['(a|b).pdf'], 'a.pdf'), false);
    assert.equal(protectedBy(['a\\b.pdf'], 'aXb.pdf'), false);
  });

  it('normalises the candidate path (.. , ./ and duplicate slashes)', () => {
    assert.equal(protectedBy(['scans'], 'other/../scans//a.pdf'), true);
    assert.equal(protectedBy(['scans'], './scans/a.pdf'), true);
    assert.equal(protectedBy(['scans'], '/scans/a.pdf'), true);
  });

  it('normalises the pattern (leading/trailing slashes)', () => {
    assert.equal(protectedBy(['/scans/'], 'scans/a.pdf'), true);
  });

  it('protects a path if any pattern matches', () => {
    assert.equal(protectedBy(['one', '**/*.pdf'], 'one/x.png'), true);
    assert.equal(protectedBy(['one', '**/*.pdf'], 'two/x.pdf'), true);
    assert.equal(protectedBy(['one', '**/*.pdf'], 'two/x.png'), false);
  });

  it('ignores patterns that normalise to nothing', () => {
    assert.equal(protectedBy(['', '/', '.'], 'a.pdf'), false);
  });

  it('a trailing ** also covers the folder path itself', () => {
    assert.equal(protectedBy(['private/**'], 'private'), true);
  });

  describe('worst-case input stays fast (no backtracking blow-up)', () => {
    const timed = (fn) => { const t = Date.now(); const r = fn(); return { r, ms: Date.now() - t }; };

    it('stacked ** against a very deep path', () => {
      const deep = Array(5000).fill('a').join('/');
      const { r, ms } = timed(() => protectedBy(['**/**/**/**/**/x.pdf'], deep));
      assert.equal(r, false);
      assert.ok(ms < 1000, `took ${ms} ms`);
    });

    it('stacked ** that does match, against a very deep path', () => {
      const deep = Array(5000).fill('a').join('/') + '/x.pdf';
      const { r, ms } = timed(() => protectedBy(['**/**/**/**/**/x.pdf'], deep));
      assert.equal(r, true);
      assert.ok(ms < 1000, `took ${ms} ms`);
    });

    it('many * in one segment against a long non-matching segment', () => {
      const long = 'a'.repeat(100_000);
      const { r, ms } = timed(() => protectedBy(['*a*a*a*a*a*b'], long));
      assert.equal(r, false);
      assert.ok(ms < 2000, `took ${ms} ms`);
    });
  });
});

describe('checkBinaryMove', () => {
  const c = compileBinaryPatterns(['scans', '**/*.locked.pdf']);

  it('refuses a move from a protected path to an unprotected one', () => {
    const r = checkBinaryMove(c, 'scans/a.pdf', 'inbox/a.pdf');
    assert.ok(r?.includes('Reading is restricted'));
    assert.ok(r.includes("'scans/a.pdf'"));
  });

  it('refuses an in-place rename that leaves the pattern', () => {
    const r = checkBinaryMove(c, 'docs/a.locked.pdf', 'docs/a.pdf');
    assert.ok(r?.includes('Reading is restricted'));
  });

  it('allows a move between two protected locations', () => {
    assert.equal(checkBinaryMove(c, 'scans/a.pdf', 'scans/2026/a.pdf'), null);
    assert.equal(checkBinaryMove(c, 'scans/a.pdf', 'docs/a.locked.pdf'), null);
  });

  it('allows moving an unprotected file into a protected location', () => {
    assert.equal(checkBinaryMove(c, 'inbox/a.pdf', 'scans/a.pdf'), null);
  });

  it('allows a move between two unprotected locations', () => {
    assert.equal(checkBinaryMove(c, 'inbox/a.pdf', 'archive/a.pdf'), null);
  });

  it('judges the destination by its normalised path, so .. cannot disguise an escape', () => {
    const r = checkBinaryMove(c, 'scans/a.pdf', 'scans/../inbox/a.pdf');
    assert.ok(r?.includes('Reading is restricted'));
  });

  it('allows everything when nothing is protected', () => {
    assert.equal(checkBinaryMove(compileBinaryPatterns([]), 'scans/a.pdf', 'inbox/a.pdf'), null);
  });
});

describe('upload-binary access', () => {
  it('blocks a denied destination', () => {
    const r = checkAccess(DENY, 'upload-binary', { folder: 'people', filename: 'a.pdf' });
    assert.ok(r?.includes('restricted'));
  });

  it('blocks a ..-traversal into a denied destination', () => {
    const r = checkAccess(DENY, 'upload-binary', { folder: 'projects/../people', filename: 'a.pdf' });
    assert.ok(r?.includes('restricted'));
  });

  it('allows a permitted destination', () => {
    assert.equal(checkAccess(DENY, 'upload-binary', { folder: 'projects', filename: 'a.pdf' }), null);
  });
});
