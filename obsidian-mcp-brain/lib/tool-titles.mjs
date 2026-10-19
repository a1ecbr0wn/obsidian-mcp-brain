// The display titles of the server's tools. A tool's `name` is what the model calls and what
// permission rules and the audit log use, so it keeps its dashes; the `title` is the phrase a
// client shows a person. All titles live in this one table. withTitles throws on a tool without
// a title and on a title without a tool, so the two cannot drift apart unnoticed; given a way to
// report a problem, it reports it instead, and a tool without a title gets one made from its name.

/** Tool name to display title. */
export const TOOL_TITLES = Object.freeze({
  'list-notes': 'List notes',
  'list-files': 'List files',
  'list-tags': 'List tags',
  'search-tags': 'Search tags',
  'new-notes': 'Recently created notes',
  'changed-notes': 'Recently changed notes',
  'list-vaults': 'List vaults',
  'get-setup-status': 'Get setup status',
  'read-note': 'Read note',
  'create-note': 'Create note',
  'edit-note': 'Edit note',
  'delete-note': 'Delete note',
  'move-note': 'Move note',
  'create-file': 'Create file',
  'fetch-file': 'Fetch file',
  'upload-file': 'Upload file',
  'replace-file': 'Replace file',
  'read-file': 'Read file',
  'move-file': 'Move file',
  'delete-file': 'Delete file',
  'find-backlinks': 'Find backlinks',
  'resolve-wikilink': 'Resolve wikilink',
  'create-folder': 'Create folder',
  'search-vault': 'Search vault',
  'add-tags': 'Add tags',
  'remove-tags': 'Remove tags',
  'rename-tag': 'Rename tag',
  'set-frontmatter-field': 'Set frontmatter field',
  'remove-frontmatter-field': 'Remove frontmatter field',
  'query-graph': 'Query graph',
});

/**
 * A title made from a tool's name, for a tool that has none: dashes become spaces and the first
 * letter is a capital.
 * @param {string} name
 * @returns {string}
 */
export function titleFromName(name) {
  const words = name.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The tool definitions with their titles added, as `title` and as `annotations.title` (older
 * clients read the second).
 *
 * Without `onProblem` a tool with no title, or a title for a tool that does not exist, throws:
 * this is how the tests keep the table complete. With it, the server keeps running: the
 * problem is passed to `onProblem`, and a tool with no title gets one made from its name.
 * @param {ReadonlyArray<{name: string, annotations?: object}>} definitions - The tools as written.
 * @param {Readonly<Record<string, string>>} [titles] - Name to title; the server's own table by default.
 * @param {(message: string) => void} [onProblem] - Called once for each problem instead of throwing.
 * @returns {object[]} New tool objects; the definitions are not changed.
 * @throws {Error} If there is a problem and no `onProblem` was given.
 */
export function withTitles(definitions, titles = TOOL_TITLES, onProblem) {
  const problem = (message) => {
    if (!onProblem) throw new Error(message);
    onProblem(message);
  };
  const names = new Set(definitions.map(t => t.name));
  for (const name of names) {
    if (!Object.hasOwn(titles, name)) problem(`tool ${name} has no title in lib/tool-titles.mjs`);
  }
  for (const name of Object.keys(titles)) {
    if (!names.has(name)) problem(`lib/tool-titles.mjs has a title for ${name}, which is not a tool`);
  }
  return definitions.map((t) => {
    const title = Object.hasOwn(titles, t.name) ? titles[t.name] : titleFromName(t.name);
    return { ...t, title, annotations: { ...t.annotations, title } };
  });
}
