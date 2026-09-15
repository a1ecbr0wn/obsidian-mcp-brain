// Pure functions for heading-section replacement and checkbox toggling within note content.
// All functions take and return strings; no filesystem I/O.

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Computes which lines fall inside a fenced code block (``` or ~~~, optionally indented
 * up to 3 spaces), so heading/checkbox parsing can skip them — otherwise a code sample
 * containing e.g. `# comment` or `- [ ] text` would be misread as real note structure.
 * @returns {boolean[]} true for each line index that is part of a fence (opening/closing
 *   fence lines included, since neither is itself a heading or checkbox line).
 */
function computeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let fenceChar = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (fenceChar) {
      mask[i] = true;
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    } else if (m) {
      fenceChar = m[1][0];
      fenceLen = m[1].length;
      mask[i] = true;
    }
  }
  return mask;
}

/**
 * Parses all ATX headings (# through ######) in content, ignoring lines inside fenced
 * code blocks. Setext-style (===/---) headings are not recognised.
 * @returns {Array<{text: string, level: number, line: number, bodyEndLine: number}>}
 *   line is 1-based. bodyEndLine is the 1-based last line belonging to this heading's
 *   section — everything up to (but not including) the next heading of the same or
 *   shallower level, or the last line of the file if there is none.
 */
export function findHeadings(content) {
  const lines = content.split('\n');
  const inFence = computeFenceMask(lines);
  const headings = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ text: m[2].trim(), level: m[1].length, line: i + 1 });
  });
  return headings.map((h, idx) => {
    let bodyEndLine = lines.length;
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        bodyEndLine = headings[j].line - 1;
        break;
      }
    }
    return { ...h, bodyEndLine };
  });
}

/**
 * Constructs an error message for an ambiguous match, listing all matches and suggesting
 * the user retry with an occurrence parameter to disambiguate.
 * @param {string} kind — "heading" or "task" (used in error message)
 * @param {string} matchText — the search term that matched multiple times
 * @param {Array} matches — array of matching objects
 * @param {Function} describeMatch — function that takes a match and returns a descriptive string
 * @returns {Error} an error with formatted message describing all matches
 */
function ambiguityError(kind, matchText, matches, describeMatch) {
  const list = matches.map((m, i) => `${i + 1}. ${describeMatch(m)}`).join('\n');
  return new Error(
    `Ambiguous ${kind} "${matchText}" — ${matches.length} matches:\n${list}\nRetry with an occurrence parameter (1-${matches.length}).`,
  );
}

/**
 * Selects a match from an array using a 1-based occurrence index, with validation and
 * fallback to the first match if occurrence is undefined. Throws if occurrence is not a
 * positive integer or if the requested occurrence index is out of bounds.
 * @param {Array} matches — array of matches to select from
 * @param {number} occurrence — 1-based index into matches; undefined defaults to the first match
 * @returns {*} the selected match object
 * @throws {Error} if occurrence is not a positive integer, or if index is out of bounds
 */
function pickMatch(matches, occurrence) {
  if (occurrence !== undefined && !(Number.isInteger(occurrence) && occurrence >= 1)) {
    throw new Error(`Invalid occurrence ${occurrence}: must be a positive integer`);
  }
  const idx = occurrence !== undefined ? occurrence - 1 : 0;
  const match = matches[idx];
  if (!match) {
    throw new Error(
      `Invalid occurrence ${occurrence}: ${matches.length} match(es) available`,
    );
  }
  return match;
}

/**
 * Replaces the content under the heading matching `heading` (exact text) with `newBody`,
 * leaving the heading line itself untouched. The replaced span runs from immediately after
 * the heading line up to (but not including) the next heading of the same or shallower
 * level, or end of file.
 *
 * Throws if `heading` matches no heading, or matches more than one and no `occurrence`
 * (1-based) is given to disambiguate.
 */
export function replaceSection(content, heading, newBody, occurrence) {
  const headings = findHeadings(content);
  const matches = headings.filter(h => h.text === heading);
  if (matches.length === 0) {
    throw new Error(`Heading not found: ${heading}`);
  }
  if (matches.length > 1 && occurrence === undefined) {
    throw ambiguityError('heading', heading, matches, m => `line ${m.line} (level ${m.level})`);
  }
  const match = pickMatch(matches, occurrence);

  const lines = content.split('\n');
  const before = lines.slice(0, match.line);
  const after = lines.slice(match.bodyEndLine);
  return [...before, ...newBody.split('\n'), ...after].join('\n');
}

/**
 * Parses all Markdown checkbox list items (`- [ ]`/`- [x]`, `*` bullets also accepted),
 * ignoring lines inside fenced code blocks.
 * @returns {Array<{text: string, checked: boolean, line: number}>} line is 1-based.
 */
export function findCheckboxes(content) {
  const lines = content.split('\n');
  const inFence = computeFenceMask(lines);
  const boxes = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = CHECKBOX_RE.exec(line);
    if (m) boxes.push({ text: m[2].trim(), checked: m[1].toLowerCase() === 'x', line: i + 1 });
  });
  return boxes;
}

/**
 * Sets the checked state of the checkbox line whose text (after the marker) exactly
 * matches `taskText`. If `checked` is omitted, the box's current state is flipped;
 * otherwise it's set to that explicit boolean.
 *
 * Throws if `taskText` matches no checkbox, or matches more than one and no `occurrence`
 * (1-based) is given to disambiguate.
 */
export function toggleCheckbox(content, taskText, checked, occurrence) {
  const boxes = findCheckboxes(content);
  const matches = boxes.filter(b => b.text === taskText);
  if (matches.length === 0) {
    throw new Error(`Checkbox not found: ${taskText}`);
  }
  if (matches.length > 1 && occurrence === undefined) {
    throw ambiguityError('task', taskText, matches, m => `line ${m.line} (currently ${m.checked ? 'checked' : 'unchecked'})`);
  }
  const match = pickMatch(matches, occurrence);

  const newChecked = checked === undefined ? !match.checked : checked;
  const lines = content.split('\n');
  lines[match.line - 1] = lines[match.line - 1].replace(/\[[ xX]\]/, `[${newChecked ? 'x' : ' '}]`);
  return lines.join('\n');
}
