// Pure functions for Obsidian YAML frontmatter parsing and tag manipulation.
// All functions take and return content strings; no filesystem I/O.

import { escRe } from './utils.mjs';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const TAGS_INLINE_RE = /^tags:\s*\[([^\]]*)\]/m;
const TAGS_BLOCK_RE = /^tags:\s*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)*)/m;

/** Matches `field: [...]` inline-array style, for any field name. */
function fieldInlineRe(field) {
  return new RegExp(`^${escRe(field)}:[ \\t]*\\[[^\\]]*\\][ \\t]*$`, 'm');
}

/** Matches `field:\n  - ...` block-sequence style, for any field name. */
function fieldBlockRe(field) {
  return new RegExp(`^${escRe(field)}:\\s*\\r?\\n((?:[ \\t]+-[^\\r\\n]*\\r?\\n?)*)`, 'm');
}

/** Matches a plain `field: value` scalar line, for any field name. */
function fieldScalarRe(field) {
  return new RegExp(`^${escRe(field)}:[ \\t]*[^\\r\\n]*$`, 'm');
}

const YAML_SPECIAL_LEADING = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_LOOKS_LIKE_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const YAML_LOOKS_LIKE_KEYWORD = /^(true|false|null|~)$/i;

/**
 * Serializes a scalar value (string/number/boolean) for a single YAML
 * frontmatter line, quoting a string only when required to keep it a string.
 * @returns {string} The serialized value, quoted if necessary.
 */
export function serializeScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const needsQuoting =
    value === '' ||
    /[\r\n]/.test(value) ||
    value.includes(': ') ||
    YAML_SPECIAL_LEADING.test(value) ||
    YAML_LOOKS_LIKE_NUMBER.test(value) ||
    YAML_LOOKS_LIKE_KEYWORD.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
}

function parseTagsFromBody(body) {
  const inline = TAGS_INLINE_RE.exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const block = TAGS_BLOCK_RE.exec(body);
  if (block) {
    return block[1]
      .split('\n')
      .map(l => l.replace(/^[ \t]+-\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Extracts tag list from YAML frontmatter (inline or block format).
 * @returns {string[]} Tag names, or empty array if no frontmatter or tags found.
 */
export function parseTags(content) {
  const fm = FM_RE.exec(content);
  return fm ? parseTagsFromBody(fm[1]) : [];
}

function buildTagsSection(tags) {
  if (tags.length === 0) return 'tags: []';
  return `tags:\n${tags.map(t => `  - ${t}`).join('\n')}`;
}

function replaceTagsInBody(body, tags) {
  const newSection = buildTagsSection(tags);
  if (TAGS_INLINE_RE.test(body)) {
    return body.replace(TAGS_INLINE_RE, newSection);
  }
  if (TAGS_BLOCK_RE.test(body)) {
    // Block regex captures trailing newlines in each entry; replace whole block + trailing newline
    return body.replace(TAGS_BLOCK_RE, newSection + '\n');
  }
  return body.trimEnd() + '\n' + newSection;
}

/**
 * Replaces the tags section in frontmatter, creating frontmatter if missing.
 */
export function setTags(content, tags) {
  const fm = FM_RE.exec(content);
  if (!fm) {
    return `---\n${buildTagsSection(tags)}\n---\n${content}`;
  }
  const newBody = replaceTagsInBody(fm[1], tags);
  const after = content.slice(fm.index + fm[0].length);
  return `---\n${newBody.trimEnd()}\n---${fm[2]}${after}`;
}

/**
 * Adds tags to frontmatter, skipping duplicates. Returns content unchanged if all tags already exist.
 */
export function addTags(content, tagsToAdd) {
  const existing = parseTags(content);
  const existingSet = new Set(existing);
  const toAdd = tagsToAdd.filter(t => !existingSet.has(t));
  if (!toAdd.length) return content;
  return setTags(content, [...existing, ...toAdd]);
}

/**
 * Removes tags from frontmatter. Returns content unchanged if no tags were removed.
 */
export function removeTags(content, tagsToRemove) {
  const existing = parseTags(content);
  const removeSet = new Set(tagsToRemove);
  const remaining = existing.filter(t => !removeSet.has(t));
  if (remaining.length === existing.length) return content;
  return setTags(content, remaining);
}

/**
 * Renames a tag in frontmatter only. Returns content unchanged if tag not found.
 */
export function renameFrontmatterTag(content, oldTag, newTag) {
  const tags = parseTags(content);
  if (!tags.includes(oldTag)) return content;
  return setTags(content, tags.map(t => (t === oldTag ? newTag : t)));
}

/**
 * Renames inline tags (e.g., #tag syntax) in content, respecting word boundaries.
 * Matches tags preceded by whitespace or start-of-line, not followed by tag-valid characters.
 */
export function renameInlineTag(content, oldTag, newTag) {
  // Match #tag preceded by whitespace or start-of-line, not followed by tag-valid chars
  // Tag-valid chars in Obsidian: [a-zA-Z0-9_/-]
  const re = new RegExp(`(^|[ \\t])#${escRe(oldTag)}(?![a-zA-Z0-9_/\\-])`, 'gm');
  return content.replace(re, (_, prefix) => `${prefix}#${newTag}`);
}

/**
 * Renames a tag everywhere: in frontmatter and inline (#tag syntax).
 */
export function renameTag(content, oldTag, newTag) {
  let result = renameFrontmatterTag(content, oldTag, newTag);
  result = renameInlineTag(result, oldTag, newTag);
  return result;
}

/** Replaces a field with a new line, handling inline, block, scalar, or missing cases. */
function replaceFieldInBody(body, field, newLine) {
  if (fieldInlineRe(field).test(body)) {
    return body.replace(fieldInlineRe(field), newLine);
  }
  if (fieldBlockRe(field).test(body)) {
    return body.replace(fieldBlockRe(field), newLine + '\n');
  }
  if (fieldScalarRe(field).test(body)) {
    return body.replace(fieldScalarRe(field), newLine);
  }
  const trimmed = body.trimEnd();
  return trimmed ? trimmed + '\n' + newLine : newLine;
}

/**
 * Sets a single frontmatter field to a scalar value, creating the
 * frontmatter block or the field itself if either is missing. Overwrites
 * an existing inline, block, or scalar value for that field.
 */
export function setFrontmatterField(content, field, value) {
  const newLine = `${field}: ${serializeScalar(value)}`;
  const fm = FM_RE.exec(content);
  if (!fm) {
    return `---\n${newLine}\n---\n${content}`;
  }
  const newBody = replaceFieldInBody(fm[1], field, newLine);
  const after = content.slice(fm.index + fm[0].length);
  return `---\n${newBody.trimEnd()}\n---${fm[2]}${after}`;
}

/** Removes a field and its value from the body; returns null if the field is not found. */
function removeFieldFromBody(body, field) {
  if (fieldInlineRe(field).test(body)) {
    return body.replace(new RegExp(`^${escRe(field)}:[ \\t]*\\[[^\\]]*\\][ \\t]*\\r?\\n?`, 'm'), '');
  }
  if (fieldBlockRe(field).test(body)) {
    return body.replace(fieldBlockRe(field), '');
  }
  if (fieldScalarRe(field).test(body)) {
    return body.replace(new RegExp(`^${escRe(field)}:[ \\t]*[^\\r\\n]*\\r?\\n?`, 'm'), '');
  }
  return null;
}

/**
 * Removes a single frontmatter field (its inline, block, or scalar value).
 * Returns content unchanged if the field or the frontmatter block itself
 * doesn't exist.
 */
export function removeFrontmatterField(content, field) {
  const fm = FM_RE.exec(content);
  if (!fm) return content;
  const newBody = removeFieldFromBody(fm[1], field);
  if (newBody === null) return content;
  const after = content.slice(fm.index + fm[0].length);
  const trimmed = newBody.trimEnd();
  return trimmed ? `---\n${trimmed}\n---${fm[2]}${after}` : `---\n---${fm[2]}${after}`;
}
