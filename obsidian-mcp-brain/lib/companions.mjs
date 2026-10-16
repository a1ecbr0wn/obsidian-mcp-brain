/**
 * The companion skills and agents that ship with the server (the repository's `skills/` and
 * `agents/` folders, packaged as a plugin), and the text that tells a connected agent about
 * them: the `instructions` sent in `initialize` and the result of the `get-setup-status` tool.
 *
 * The npm package carries only the server and `lib/`, so the server cannot read `skills/` at
 * run time. The list is therefore code, and `test/plugin.test.mjs` fails if it differs from
 * the folders. The server does not know what a client has installed or which surface it runs
 * on: the agent works that out and checks its own skill and agent list for these names.
 */

/**
 * The project's own repository (`owner/name`), and the URL of its latest release page, where the
 * plugin and the release assets are published.
 */
export const REPOSITORY = 'a1ecbr0wn/obsidian-mcp-brain';
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`;

/**
 * One entry per folder in `skills/` and file in `agents/`. `purpose` is the first sentence of
 * the skill's or agent's `description`; `tools` are the server tools it helps.
 * @type {ReadonlyArray<Readonly<{type: 'skill'|'agent', name: string, purpose: string, tools: readonly string[]}>>}
 */
export const COMPANIONS = Object.freeze([
  Object.freeze({
    type: 'skill',
    name: 'read-binary-file',
    purpose: 'Read a PDF, image or other non-note file from an Obsidian vault through the obsidian-mcp-brain server\'s read-binary-file tool.',
    tools: Object.freeze(['read-binary-file']),
  }),
  Object.freeze({
    type: 'skill',
    name: 'upload-binary-file',
    purpose: 'Put a local file (a PDF, image or other binary) into an Obsidian vault through the obsidian-mcp-brain server\'s upload-binary-file tool, without base64-encoding it.',
    tools: Object.freeze(['upload-binary-file']),
  }),
]);

/** Text sent in the `initialize` result. The same for every client, and under 1,000 characters. */
export const SETUP_INSTRUCTIONS = [
  'This server has companion skills and agents (a plugin) that make some of its tools work better:',
  'read-binary-file is dropped by chat surfaces without its skill, and upload-binary-file needs its skill\'s script.',
  'Before the first use of read-binary-file or upload-binary-file, call get-setup-status once to see what to install and how.',
  'Skip it if those skills are already in your skill list.',
  'The result also gives the server version: if an installed companion skill\'s metadata.version is older, tell the user a plugin update is available.',
].join(' ');

/**
 * Guidance for each Claude surface, as [heading, lines] pairs, rendered after the companion list
 * by setupStatusText. Internal to this module.
 */
const SURFACES = [
  [
    'How to tell which surface you are on',
    [
      'Claude Code, including the code mode of the Claude Desktop app: skills load from ~/.claude/skills/ or ~/.claude/plugins/ under a home directory that is not /home/claude.',
      'Claude Desktop chat and claude.ai chat: skills load from /mnt/skills/... and the home directory is /home/claude.',
      'Cowork: skills load from /root/.claude/skills/synced/....',
    ],
  ],
  [
    'Install',
    [
      `Claude Code and the Desktop code mode: /plugin marketplace add ${REPOSITORY}, then /plugin install obsidian-mcp-brain@obsidian-mcp-brain.`,
      `Cowork, Claude Desktop chat and claude.ai: download obsidian-mcp-brain.plugin from ${RELEASES_URL} and upload it at Customize > Plugins > Add > Upload plugin. Agents in a plugin are ignored in chat; only Claude Code and Cowork run them.`,
      'One skill only, on Claude Desktop chat or claude.ai: download <name>.skill from the same release and upload it at Settings > Capabilities > Skills.',
      'Anywhere else: copy a folder from skills/ in the repository into the skills folder of the client, or an agent file <name>.md into ~/.claude/agents/.',
    ],
  ],
];

/**
 * The text returned by `get-setup-status`, generated from COMPANIONS so that it cannot drift.
 * @param {string} serverVersion - The running server's version, for the agent to compare with
 *   an installed skill's `metadata.version`.
 * @returns {string}
 */
export function setupStatusText(serverVersion) {
  const lines = [
    `obsidian-mcp-brain ${serverVersion}. Companion skills and agents, released with the server (${RELEASES_URL}):`,
    ...COMPANIONS.map(c => `- ${c.type} ${c.name}: ${c.purpose} Helps: ${c.tools.join(', ')}.`),
    '',
    'Check your own skill and agent list for these names. If one is missing, install it as below. If one is installed and its metadata.version is older than the server version above, tell the user a plugin update is available.',
  ];
  for (const [title, items] of SURFACES) {
    lines.push('', `${title}:`, ...items.map(i => `- ${i}`));
  }
  lines.push(
    '',
    'Without them:',
    '- read-binary-file: a chat surface shows only images from the result. Tell the user to use a Claude Code or Cowork session for a PDF or other file instead of retrying.',
    '- upload-binary-file: it needs a shell and curl. If Claude Code refuses the command, the user can allow it with a permission rule in permissions.allow of ~/.claude/settings.json, Bash(sh <path of the skill\'s upload-binary-file.sh> *), written the way the command appears when it is refused (/permissions lists the rules). For a small file, create-binary-file needs no curl.',
  );
  return lines.join('\n');
}
