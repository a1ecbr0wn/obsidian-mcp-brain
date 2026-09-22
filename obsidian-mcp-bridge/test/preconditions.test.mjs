import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { formatMtime, validateExpectedMtime, assertUnmodified } from '../lib/preconditions.mjs';

describe('formatMtime', () => {
  test('formats a Stats mtime as the same ISO 8601 string toISOString() produces', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preconditions-'));
    const file = path.join(dir, 'note.md');
    await fs.writeFile(file, 'x');
    const stat = await fs.stat(file);
    assert.equal(formatMtime(stat), stat.mtime.toISOString());
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('validateExpectedMtime', () => {
  test('accepts a well-formed ISO 8601 mtime string', () => {
    assert.doesNotThrow(() => validateExpectedMtime('2026-09-15T17:23:50.054Z'));
  });

  test('rejects a non-string value', () => {
    assert.throws(() => validateExpectedMtime(12345), /invalid expectedMtime/i);
  });

  test('rejects a malformed string', () => {
    assert.throws(() => validateExpectedMtime('yesterday'), /invalid expectedMtime/i);
  });

  test('rejects a date-only string missing the time component', () => {
    assert.throws(() => validateExpectedMtime('2026-09-15'), /invalid expectedMtime/i);
  });
});

describe('assertUnmodified', () => {
  let dir, file;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preconditions-'));
    file = path.join(dir, 'note.md');
    await fs.writeFile(file, 'content');
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('passes when expectedMtime matches the file\'s current mtime', async () => {
    const stat = await fs.stat(file);
    await assert.doesNotReject(() => assertUnmodified(file, formatMtime(stat)));
  });

  test('throws naming both values when mtime has drifted', async () => {
    const stat = await fs.stat(file);
    const stale = new Date(stat.mtime.getTime() - 60_000).toISOString();
    await assert.rejects(() => assertUnmodified(file, stale), err => {
      assert.match(err.message, /precondition failed/i);
      assert.ok(err.message.includes(stale));
      assert.ok(err.message.includes(formatMtime(stat)));
      return true;
    });
  });

  test('throws a distinct error when the file no longer exists', async () => {
    await assert.rejects(
      () => assertUnmodified(path.join(dir, 'ghost.md'), '2026-01-01T00:00:00.000Z'),
      /no longer exists/i,
    );
  });

  test('rejects a malformed expectedMtime before touching the filesystem', async () => {
    await assert.rejects(() => assertUnmodified(file, 'not-a-timestamp'), /invalid expectedMtime/i);
  });
});
