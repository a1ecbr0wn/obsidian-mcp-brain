// Line endings of a note. A note's ending is the ending of its first line break, so a tool that
// writes new lines into a note writes them in the ending the note already uses, and never
// changes the ending of the lines it leaves alone. Pure functions; no filesystem I/O.

/**
 * The line ending of a note: CRLF if its first line break is CRLF, otherwise LF. A note with
 * no line break (or an empty one) has no ending of its own and gets LF.
 * @param {string} text
 * @returns {'\n'|'\r\n'}
 */
export function detectLineEnding(text) {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Turns every line break in `text` (CRLF or LF) into `ending`. A lone carriage return is not a
 * line break here and is left as it is.
 * @param {string} text
 * @param {'\n'|'\r\n'} ending
 * @returns {string}
 */
export function toLineEnding(text, ending) {
  return text.replace(/\r?\n/g, ending);
}
