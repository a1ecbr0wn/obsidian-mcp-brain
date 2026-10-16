import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLineEnding, toLineEnding } from '../lib/lineending.mjs';

describe('detectLineEnding', () => {
  it('is LF for an LF note and CRLF for a CRLF note', () => {
    assert.equal(detectLineEnding('a\nb\nc\n'), '\n');
    assert.equal(detectLineEnding('a\r\nb\r\nc\r\n'), '\r\n');
  });

  it('follows the first line break of a mixed note', () => {
    assert.equal(detectLineEnding('a\r\nb\nc\n'), '\r\n');
    assert.equal(detectLineEnding('a\nb\r\nc\r\n'), '\n');
    assert.equal(detectLineEnding('---\r\nx: 1\r\n---\r\n# H\nbody\nmore\nlines\n'), '\r\n');
  });

  it('is LF when the note has no line break, or is empty', () => {
    assert.equal(detectLineEnding('just one line'), '\n');
    assert.equal(detectLineEnding(''), '\n');
  });

  it('is LF when the note starts with a bare line break', () => {
    assert.equal(detectLineEnding('\nx\r\n'), '\n');
  });

  it('ignores a lone carriage return', () => {
    assert.equal(detectLineEnding('a\rb\nc'), '\n');
    assert.equal(detectLineEnding('a\rb\r\nc'), '\r\n');
  });
});

describe('toLineEnding', () => {
  it('turns every line break into the given ending', () => {
    assert.equal(toLineEnding('a\nb\r\nc', '\r\n'), 'a\r\nb\r\nc');
    assert.equal(toLineEnding('a\nb\r\nc', '\n'), 'a\nb\nc');
  });

  it('does not double a carriage return', () => {
    assert.equal(toLineEnding('a\r\nb', '\r\n'), 'a\r\nb');
  });

  it('leaves text with no line break, and an empty string, alone', () => {
    assert.equal(toLineEnding('abc', '\r\n'), 'abc');
    assert.equal(toLineEnding('', '\r\n'), '');
  });

  it('keeps blank lines and a trailing break', () => {
    assert.equal(toLineEnding('a\n\nb\n', '\r\n'), 'a\r\n\r\nb\r\n');
  });

  it('leaves a lone carriage return alone', () => {
    assert.equal(toLineEnding('a\rb', '\r\n'), 'a\rb');
  });
});
