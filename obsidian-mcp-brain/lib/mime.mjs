// Extension-to-MIME-type map for read-binary-file. Clients choose how to handle a
// returned blob from its mimeType, so the common attachment types are named and
// everything else is an opaque byte stream.
import path from 'node:path';

const MIME_TYPES = {
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

/**
 * Returns the MIME type for a file name, from its final extension (case-insensitive).
 * @param {string} filename - A file name or vault-relative path.
 * @returns {string} The mapped type, or 'application/octet-stream' when unknown.
 */
export function mimeTypeFor(filename) {
  return MIME_TYPES[path.posix.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
