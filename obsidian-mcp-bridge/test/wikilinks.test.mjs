import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLinks, extractLinks, extractReferences } from '../lib/wikilinks.mjs';

// ── extractLinks ─────────────────────────────────────────────────────────────

describe('extractLinks', () => {
  it('extracts bare filename links', () => {
    const links = extractLinks('See [[note]] for details.');
    assert.deepEqual(links, [{ target: 'note', heading: '', alias: '' }]);
  });

  it('extracts path links', () => {
    const links = extractLinks('See [[folder/note]] here.');
    assert.deepEqual(links, [{ target: 'folder/note', heading: '', alias: '' }]);
  });

  it('extracts links with alias', () => {
    const links = extractLinks('See [[note|My Note]] here.');
    assert.deepEqual(links, [{ target: 'note', heading: '', alias: 'My Note' }]);
  });

  it('extracts links with heading', () => {
    const links = extractLinks('See [[note#section]] here.');
    assert.deepEqual(links, [{ target: 'note', heading: 'section', alias: '' }]);
  });

  it('extracts links with path, heading, and alias', () => {
    const links = extractLinks('See [[folder/note#section|label]] here.');
    assert.deepEqual(links, [{ target: 'folder/note', heading: 'section', alias: 'label' }]);
  });

  it('extracts multiple links', () => {
    const links = extractLinks('[[a]] and [[b|B]] and [[c#h]].');
    assert.equal(links.length, 3);
    assert.equal(links[0].target, 'a');
    assert.equal(links[1].target, 'b');
    assert.equal(links[2].target, 'c');
  });

  it('returns empty array when no links', () => {
    assert.deepEqual(extractLinks('No links here.'), []);
  });
});

// ── extractReferences ────────────────────────────────────────────────────────

describe('extractReferences', () => {
  it('extracts a plain link with embed: false', () => {
    const refs = extractReferences('See [[note]] for details.');
    assert.deepEqual(refs, [{ target: 'note', heading: '', alias: '', embed: false }]);
  });

  it('extracts an embed with embed: true', () => {
    const refs = extractReferences('See ![[image.png]] for details.');
    assert.deepEqual(refs, [{ target: 'image.png', heading: '', alias: '', embed: true }]);
  });

  it('extracts heading and alias on both links and embeds', () => {
    const refs = extractReferences('[[note#section|Label]] and ![[image.png|Alt]]');
    assert.deepEqual(refs, [
      { target: 'note', heading: 'section', alias: 'Label', embed: false },
      { target: 'image.png', heading: '', alias: 'Alt', embed: true },
    ]);
  });

  it('extracts multiple mixed references in order', () => {
    const refs = extractReferences('[[a]] then ![[b.png]] then [[c]]');
    assert.deepEqual(refs.map(r => [r.target, r.embed]), [['a', false], ['b.png', true], ['c', false]]);
  });

  it('returns empty array when no references', () => {
    assert.deepEqual(extractReferences('No links here.'), []);
  });
});

// ── rewriteLinks ─────────────────────────────────────────────────────────────

describe('rewriteLinks', () => {
  it('rewrites bare filename link when note moves to a folder', () => {
    const content = 'See [[recipe]] here.';
    // note was at recipe.md (vault root), now at food/recipe.md
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe]] here.');
  });

  it('rewrites full path link', () => {
    const content = 'See [[food/recipe]] here.';
    const result = rewriteLinks(content, 'food/recipe', 'cooking/recipe');
    assert.equal(result, 'See [[cooking/recipe]] here.');
  });

  it('rewrites link by basename when note moves between folders', () => {
    const content = 'See [[recipe]] here.';
    // note was at old/recipe.md, now at new/recipe.md — bare link matches basename
    const result = rewriteLinks(content, 'old/recipe', 'new/recipe');
    assert.equal(result, 'See [[new/recipe]] here.');
  });

  it('preserves alias', () => {
    const content = 'See [[recipe|My Recipe]] here.';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe|My Recipe]] here.');
  });

  it('preserves heading anchor', () => {
    const content = 'See [[recipe#ingredients]] here.';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe#ingredients]] here.');
  });

  it('preserves heading and alias together', () => {
    const content = 'See [[folder/recipe#ingredients|label]] here.';
    const result = rewriteLinks(content, 'folder/recipe', 'food/recipe');
    assert.equal(result, 'See [[food/recipe#ingredients|label]] here.');
  });

  it('rewrites multiple occurrences', () => {
    const content = '[[recipe]] and [[recipe|alias]] and [[recipe#h]]';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, '[[food/recipe]] and [[food/recipe|alias]] and [[food/recipe#h]]');
  });

  it('does not rewrite links to other notes with similar names', () => {
    const content = '[[recipe-book]] and [[my-recipe]] and [[recipe]]';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, '[[recipe-book]] and [[my-recipe]] and [[food/recipe]]');
  });

  it('does not rewrite heading-only links (same-file anchors)', () => {
    const content = 'See [[#section]] here.';
    const result = rewriteLinks(content, 'section', 'other/section');
    assert.equal(result, 'See [[#section]] here.');
  });

  it('handles note with spaces in name', () => {
    const content = 'See [[my note]] here.';
    const result = rewriteLinks(content, 'my note', 'folder/my note');
    assert.equal(result, 'See [[folder/my note]] here.');
  });

  it('returns content unchanged when no matching links', () => {
    const content = 'See [[other-note]] here.';
    const result = rewriteLinks(content, 'recipe', 'food/recipe');
    assert.equal(result, content);
  });

  it('handles note rename (same folder, different name)', () => {
    const content = '[[pasta]] and [[pasta|Pasta Dish]]';
    const result = rewriteLinks(content, 'pasta', 'spaghetti');
    assert.equal(result, '[[spaghetti]] and [[spaghetti|Pasta Dish]]');
  });

  // ── embeds (used to reference binary files, e.g. images) ──────────────────

  it('rewrites a bare embed and preserves the leading !', () => {
    const content = 'See ![[image.png]] here.';
    const result = rewriteLinks(content, 'image.png', 'attachments/image.png');
    assert.equal(result, 'See ![[attachments/image.png]] here.');
  });

  it('rewrites an embed by basename when the file moves between folders', () => {
    const content = '![[image.png]]';
    const result = rewriteLinks(content, 'old/image.png', 'new/image.png');
    assert.equal(result, '![[new/image.png]]');
  });

  it('preserves alias on embeds', () => {
    const content = '![[image.png|alt text]]';
    const result = rewriteLinks(content, 'image.png', 'attachments/image.png');
    assert.equal(result, '![[attachments/image.png|alt text]]');
  });

  it('rewrites both plain links and embeds pointing to the same target', () => {
    const content = 'Linked: [[image.png]], embedded: ![[image.png]]';
    const result = rewriteLinks(content, 'image.png', 'attachments/image.png');
    assert.equal(result, 'Linked: [[attachments/image.png]], embedded: ![[attachments/image.png]]');
  });

  it('does not rewrite embeds of other files with similar names', () => {
    const content = '![[image.png]] and ![[image2.png]]';
    const result = rewriteLinks(content, 'image.png', 'attachments/image.png');
    assert.equal(result, '![[attachments/image.png]] and ![[image2.png]]');
  });

  it('does not rewrite a note link when moving a binary file with the same basename', () => {
    // A note "image.md" (linked as [[image]]) and an unrelated binary file "image.png"
    // living in a different folder both reduce to basename "image" — moving the binary
    // file must only touch its own extension-bearing embed, never the note's bare link.
    const content = 'See [[image]] the note, and ![[image.png]] the picture.';
    const result = rewriteLinks(content, 'old/image.png', 'new/image.png');
    assert.equal(result, 'See [[image]] the note, and ![[new/image.png]] the picture.');
  });
});
