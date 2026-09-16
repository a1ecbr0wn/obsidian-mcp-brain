import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags, setTags, addTags, removeTags, renameTag, serializeScalar, setFrontmatterField, removeFrontmatterField } from '../lib/frontmatter.mjs';

const FM_INLINE = `---\ntags: [type/recipe, cooking]\ntitle: Pasta\n---\n# Pasta\n`;
const FM_BLOCK = `---\ntags:\n  - type/recipe\n  - cooking\ntitle: Pasta\n---\n# Pasta\n`;
const FM_NONE = `---\ntitle: Pasta\n---\n# Pasta\n`;
const NO_FM = `# Pasta\n\nNo frontmatter here.\n`;

// ── parseTags ────────────────────────────────────────────────────────────────

describe('parseTags', () => {
  it('parses inline array tags', () => {
    assert.deepEqual(parseTags(FM_INLINE), ['type/recipe', 'cooking']);
  });

  it('parses block sequence tags', () => {
    assert.deepEqual(parseTags(FM_BLOCK), ['type/recipe', 'cooking']);
  });

  it('returns empty array when no tags key', () => {
    assert.deepEqual(parseTags(FM_NONE), []);
  });

  it('returns empty array when no frontmatter', () => {
    assert.deepEqual(parseTags(NO_FM), []);
  });

  it('handles quoted tags in inline array', () => {
    assert.deepEqual(parseTags(`---\ntags: ['type/recipe', "cooking"]\n---\n`), ['type/recipe', 'cooking']);
  });

  it('handles single tag in inline array', () => {
    assert.deepEqual(parseTags(`---\ntags: [cooking]\n---\n`), ['cooking']);
  });

  it('handles empty inline array', () => {
    assert.deepEqual(parseTags(`---\ntags: []\n---\n`), []);
  });

  it('parses hierarchical tags', () => {
    assert.deepEqual(parseTags(`---\ntags:\n  - type/recipe\n  - tech/node\n---\n`), ['type/recipe', 'tech/node']);
  });
});

// ── setTags ──────────────────────────────────────────────────────────────────

describe('setTags', () => {
  it('replaces inline array with block sequence', () => {
    const result = setTags(FM_INLINE, ['tech/node', 'cooking']);
    assert.deepEqual(parseTags(result), ['tech/node', 'cooking']);
  });

  it('replaces block sequence', () => {
    const result = setTags(FM_BLOCK, ['tech/node']);
    assert.deepEqual(parseTags(result), ['tech/node']);
  });

  it('preserves other frontmatter keys when replacing tags', () => {
    const result = setTags(FM_BLOCK, ['new-tag']);
    assert.ok(result.includes('title: Pasta'), 'other keys preserved');
  });

  it('adds tags section when frontmatter has none', () => {
    const result = setTags(FM_NONE, ['new-tag']);
    assert.deepEqual(parseTags(result), ['new-tag']);
    assert.ok(result.includes('title: Pasta'), 'other keys preserved');
  });

  it('adds frontmatter when note has none', () => {
    const result = setTags(NO_FM, ['new-tag']);
    assert.ok(result.startsWith('---\n'));
    assert.deepEqual(parseTags(result), ['new-tag']);
    assert.ok(result.includes('# Pasta'), 'body preserved');
  });

  it('handles empty tags array', () => {
    const result = setTags(FM_BLOCK, []);
    assert.deepEqual(parseTags(result), []);
  });

  it('preserves body content after frontmatter', () => {
    const result = setTags(FM_BLOCK, ['tag']);
    assert.ok(result.endsWith('# Pasta\n'));
  });
});

// ── addTags ──────────────────────────────────────────────────────────────────

describe('addTags', () => {
  it('adds new tags', () => {
    const result = addTags(FM_BLOCK, ['new-tag']);
    const tags = parseTags(result);
    assert.ok(tags.includes('new-tag'));
    assert.ok(tags.includes('type/recipe'));
    assert.ok(tags.includes('cooking'));
  });

  it('does not duplicate existing tags', () => {
    const result = addTags(FM_BLOCK, ['cooking', 'new-tag']);
    const tags = parseTags(result);
    assert.equal(tags.filter(t => t === 'cooking').length, 1);
    assert.ok(tags.includes('new-tag'));
  });

  it('returns unchanged content if all tags already present', () => {
    const result = addTags(FM_BLOCK, ['cooking', 'type/recipe']);
    assert.equal(result, FM_BLOCK);
  });

  it('adds tags to note with no frontmatter', () => {
    const result = addTags(NO_FM, ['new-tag']);
    assert.deepEqual(parseTags(result), ['new-tag']);
  });
});

// ── removeTags ───────────────────────────────────────────────────────────────

describe('removeTags', () => {
  it('removes specified tags', () => {
    const result = removeTags(FM_BLOCK, ['cooking']);
    const tags = parseTags(result);
    assert.ok(!tags.includes('cooking'));
    assert.ok(tags.includes('type/recipe'));
  });

  it('removes multiple tags', () => {
    const result = removeTags(FM_BLOCK, ['cooking', 'type/recipe']);
    assert.deepEqual(parseTags(result), []);
  });

  it('returns unchanged content if tag not present', () => {
    const result = removeTags(FM_BLOCK, ['nonexistent']);
    assert.equal(result, FM_BLOCK);
  });

  it('removes from inline array', () => {
    const result = removeTags(FM_INLINE, ['cooking']);
    assert.ok(!parseTags(result).includes('cooking'));
  });
});

// ── renameTag ────────────────────────────────────────────────────────────────

describe('renameTag', () => {
  it('renames tag in frontmatter block sequence', () => {
    const result = renameTag(FM_BLOCK, 'cooking', 'food/cooking');
    const tags = parseTags(result);
    assert.ok(tags.includes('food/cooking'));
    assert.ok(!tags.includes('cooking'));
  });

  it('renames tag in frontmatter inline array', () => {
    const result = renameTag(FM_INLINE, 'cooking', 'food/cooking');
    const tags = parseTags(result);
    assert.ok(tags.includes('food/cooking'));
    assert.ok(!tags.includes('cooking'));
  });

  it('renames inline body tags', () => {
    const content = `---\ntags: [cooking]\n---\n# Note\n\nSee #cooking for more.\n`;
    const result = renameTag(content, 'cooking', 'food/cooking');
    assert.ok(result.includes('#food/cooking'));
    assert.ok(!result.includes('\n#cooking') && !result.includes(' #cooking'));
  });

  it('renames body tag at start of line', () => {
    const content = `---\ntags: [cooking]\n---\n#cooking is used here.\n`;
    const result = renameTag(content, 'cooking', 'food/cooking');
    assert.ok(result.includes('#food/cooking'));
  });

  it('does not rename hierarchical subtags in body', () => {
    const content = `---\ntags: [type/recipe]\n---\nUse #type/recipe here.\n`;
    const result = renameTag(content, 'type', 'category');
    assert.deepEqual(parseTags(result), ['type/recipe'], 'frontmatter unchanged');
    assert.ok(result.includes('#type/recipe'), 'inline tag unchanged');
    assert.ok(!result.includes('#category'), 'no spurious rename');
  });

  it('does not rename tag that is a prefix of a hyphenated tag', () => {
    const content = `---\ntags: [cooking]\n---\nUse #cooking-notes here.\n`;
    const result = renameTag(content, 'cooking', 'food');
    // cooking-notes is a separate tag; should not be renamed
    assert.ok(result.includes('#cooking-notes'));
    assert.ok(!result.includes('#food-notes'));
  });

  it('does not rename partial word matches in body', () => {
    const content = `---\ntags: [type]\n---\n#typing is different from #type.\n`;
    const result = renameTag(content, 'type', 'category');
    assert.ok(result.includes('#typing'), '#typing preserved');
    assert.ok(result.includes('#category'), '#type renamed');
  });

  it('returns unchanged content when tag not present', () => {
    const result = renameTag(FM_BLOCK, 'nonexistent', 'new-name');
    assert.equal(result, FM_BLOCK);
  });
});

// ── serializeScalar ────────────────────────────────────────────────────────

describe('serializeScalar', () => {
  it('emits booleans as bare literals', () => {
    assert.equal(serializeScalar(true), 'true');
    assert.equal(serializeScalar(false), 'false');
  });

  it('emits numbers as bare literals', () => {
    assert.equal(serializeScalar(42), '42');
    assert.equal(serializeScalar(-3.5), '-3.5');
  });

  it('emits plain strings unquoted', () => {
    assert.equal(serializeScalar('Pasta'), 'Pasta');
    assert.equal(serializeScalar('type/recipe'), 'type/recipe');
  });

  it('quotes an empty string', () => {
    assert.equal(serializeScalar(''), '""');
  });

  it('quotes a string containing colon-space', () => {
    assert.equal(serializeScalar('key: value'), '"key: value"');
  });

  it('quotes a string starting with a YAML-special character', () => {
    assert.equal(serializeScalar('- dash'), '"- dash"');
    assert.equal(serializeScalar('#hash'), '"#hash"');
    assert.equal(serializeScalar('@at'), '"@at"');
  });

  it('quotes a string that looks like a number', () => {
    assert.equal(serializeScalar('42'), '"42"');
    assert.equal(serializeScalar('-3.5'), '"-3.5"');
  });

  it('quotes a string that looks like a boolean or null', () => {
    assert.equal(serializeScalar('true'), '"true"');
    assert.equal(serializeScalar('false'), '"false"');
    assert.equal(serializeScalar('null'), '"null"');
    assert.equal(serializeScalar('~'), '"~"');
  });

  it('quotes a string containing an embedded newline', () => {
    // Otherwise an unquoted multi-line value could splice a literal "---"
    // line into the raw frontmatter and break out of the block on write.
    const result = serializeScalar('foo\n---\nmalicious body content');
    assert.ok(result.startsWith('"') && result.endsWith('"'));
    assert.ok(!result.includes('\n'), 'newline must be escaped, not literal');
  });
});

// ── setFrontmatterField ──────────────────────────────────────────────────────

describe('setFrontmatterField', () => {
  it('creates frontmatter from nothing', () => {
    const result = setFrontmatterField(NO_FM, 'priority', 'high');
    assert.equal(result, `---\npriority: high\n---\n${NO_FM}`);
  });

  it('creates a missing field in existing frontmatter', () => {
    const result = setFrontmatterField(FM_NONE, 'priority', 'high');
    assert.equal(result, `---\ntitle: Pasta\npriority: high\n---\n# Pasta\n`);
  });

  it('overwrites an existing scalar field', () => {
    const result = setFrontmatterField(FM_NONE, 'title', 'Lasagna');
    assert.equal(result, `---\ntitle: Lasagna\n---\n# Pasta\n`);
  });

  it('overwrites a field that currently holds a stray block value', () => {
    const content = `---\nauthors:\n  - Alice\n  - Bob\ntitle: Pasta\n---\n# Pasta\n`;
    const result = setFrontmatterField(content, 'authors', 'Carol');
    assert.equal(result, `---\nauthors: Carol\ntitle: Pasta\n---\n# Pasta\n`);
  });

  it('serializes non-string scalars using serializeScalar', () => {
    const result = setFrontmatterField(FM_NONE, 'draft', true);
    assert.ok(result.includes('draft: true'));
  });

  it('does not let a value containing a newline break out of the frontmatter block', () => {
    const result = setFrontmatterField(FM_NONE, 'notes', 'foo\n---\nmalicious body content');
    // Exactly two "---" delimiter lines: the frontmatter open/close, nothing injected.
    assert.equal((result.match(/^---$/gm) ?? []).length, 2);
    assert.ok(result.includes('# Pasta'), 'original body preserved');
  });

  it('does not touch a different field that shares a name prefix', () => {
    const content = `---\ntags: [cooking]\ntag: primary\n---\n# Pasta\n`;
    const result = setFrontmatterField(content, 'tag', 'secondary');
    assert.ok(result.includes('tags: [cooking]'), 'tags field untouched');
    assert.ok(result.includes('tag: secondary'), 'tag field updated');
  });

  it('handles CRLF frontmatter without corrupting the body', () => {
    // Matches the existing setTags/replaceTagsInBody fallback behavior: a
    // newly appended line uses a bare \n, but the body's own CRLF endings
    // and content are otherwise untouched.
    const content = '---\r\ntitle: Pasta\r\n---\r\n# Pasta\r\n';
    const result = setFrontmatterField(content, 'priority', 'high');
    assert.ok(result.includes('title: Pasta'));
    assert.ok(result.includes('priority: high'));
    assert.ok(result.includes('# Pasta\r\n'), 'body CRLF preserved');
  });

  it('overwrites an existing CRLF scalar field in place, preserving the body', () => {
    const content = '---\r\ntitle: Pasta\r\n---\r\n# Pasta\r\n';
    const result = setFrontmatterField(content, 'title', 'Lasagna');
    assert.ok(result.includes('title: Lasagna'));
    assert.ok(!result.includes('title: Pasta'));
    assert.ok(result.includes('# Pasta\r\n'), 'body CRLF preserved');
  });

  it('does not leave a stray blank line when frontmatter is empty', () => {
    const result = setFrontmatterField('---\n\n---\nBody text', 'field', 'value');
    assert.equal(result, '---\nfield: value\n---\nBody text');
  });
});

// ── removeFrontmatterField ───────────────────────────────────────────────────

describe('removeFrontmatterField', () => {
  it('removes an existing scalar field', () => {
    const content = `---\ntitle: Pasta\npriority: high\n---\n# Pasta\n`;
    const result = removeFrontmatterField(content, 'priority');
    assert.equal(result, `---\ntitle: Pasta\n---\n# Pasta\n`);
  });

  it('removes an existing block field', () => {
    const content = `---\nauthors:\n  - Alice\n  - Bob\ntitle: Pasta\n---\n# Pasta\n`;
    const result = removeFrontmatterField(content, 'authors');
    assert.equal(result, `---\ntitle: Pasta\n---\n# Pasta\n`);
  });

  it('removes an existing inline-array field', () => {
    const content = `---\nauthors: [Alice, Bob]\ntitle: Pasta\n---\n# Pasta\n`;
    const result = removeFrontmatterField(content, 'authors');
    assert.equal(result, `---\ntitle: Pasta\n---\n# Pasta\n`);
  });

  it('returns unchanged content when field does not exist', () => {
    const result = removeFrontmatterField(FM_NONE, 'nonexistent');
    assert.equal(result, FM_NONE);
  });

  it('does not leave a stray blank line when removing the only field', () => {
    const result = removeFrontmatterField('---\nstatus: x\n---\nBody', 'status');
    assert.equal(result, '---\n---\nBody');
  });

  it('returns unchanged content when there is no frontmatter block', () => {
    const result = removeFrontmatterField(NO_FM, 'title');
    assert.equal(result, NO_FM);
  });
});
