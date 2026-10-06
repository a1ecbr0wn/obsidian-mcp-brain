import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mimeTypeFor } from '../lib/mime.mjs';

describe('mimeTypeFor', () => {
  it('maps known extensions', () => {
    assert.equal(mimeTypeFor('report.pdf'), 'application/pdf');
    assert.equal(mimeTypeFor('a.png'), 'image/png');
    assert.equal(mimeTypeFor('a.jpg'), 'image/jpeg');
    assert.equal(mimeTypeFor('a.jpeg'), 'image/jpeg');
    assert.equal(mimeTypeFor('a.gif'), 'image/gif');
    assert.equal(mimeTypeFor('a.webp'), 'image/webp');
    assert.equal(mimeTypeFor('a.svg'), 'image/svg+xml');
  });

  it('is case-insensitive', () => {
    assert.equal(mimeTypeFor('REPORT.PDF'), 'application/pdf');
    assert.equal(mimeTypeFor('Photo.JpG'), 'image/jpeg');
  });

  it('uses only the final extension of a vault-relative path', () => {
    assert.equal(mimeTypeFor('scans/2026/report.v2.pdf'), 'application/pdf');
    assert.equal(mimeTypeFor('archive.pdf.zip'), 'application/octet-stream');
  });

  it('falls back to application/octet-stream', () => {
    assert.equal(mimeTypeFor('data.bin'), 'application/octet-stream');
    assert.equal(mimeTypeFor('noextension'), 'application/octet-stream');
    assert.equal(mimeTypeFor('.pdf'), 'application/octet-stream');
    assert.equal(mimeTypeFor(''), 'application/octet-stream');
  });
});
