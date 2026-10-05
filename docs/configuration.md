---
layout: docs
title: "Configuration | obsidian-mcp-brain"
nav_order: 3
---

## Configuration

All configuration lives in one JSON file. No environment variables are read except
`CONFIG_PATH`, which says where to find it.

- **Location**: the file named by `CONFIG_PATH` if that is set, otherwise
  `~/.config/obsidian-mcp.json`.
- The server reads and validates it once at startup. A missing file, invalid JSON
  or a failed validation logs a clear error and exits.
- One server process can serve several named vaults. A client picks which one a
  call applies to with the `vault` argument, which every tool except `list-vaults`
  takes.

### Shape

```json
{
  "listenPort": 3002,
  "listenHost": "127.0.0.1",
  "mcpBaseUrl": "https://your-hostname:4001",
  "denyPaths": ["private"],
  "denyBinaryPaths": ["**/*.pdf"],
  "graphifyQueryTimeoutMs": 60000,
  "fetchMaxBytes": 10485760,
  "fetchTimeoutMs": 30000,
  "readMaxBytes": 10485760,
  "vaults": {
    "knowledge": {
      "path": "/path/to/your/obsidian/vault"
    },
    "work": {
      "path": "/path/to/another/vault",
      "denyPaths": ["confidential"],
      "denyBinaryPaths": ["scans"]
    }
  }
}
```

| Field                    | Required | Default    | Description                                                                             |
| ------------------------ | -------- | ---------- | --------------------------------------------------------------------------------------- |
| `mcpBaseUrl`             | Yes      | none       | Public HTTPS base URL of the server, used in OAuth responses and SSE endpoint events    |
| `vaults`                 | Yes      | none       | Non-empty object of `{ "name": { "path": "..." } }`. Each vault needs at least a `path` |
| `listenPort`             | No       | `3002`     | Local port the server listens on                                                        |
| `listenHost`             | No       | `127.0.0.1` | Address the server binds to. Leave it as loopback unless the server runs in a [container](install/install-docker), where `0.0.0.0` is needed for the published port to reach it |
| `denyPaths`              | No       | `[]`       | Vault-relative paths to block, applied to every vault                                   |
| `denyBinaryPaths`        | No       | `[]`       | Vault-relative files or folders, with wildcards, whose binary files `read-binary-file` refuses to return. See [below](#binary-read-protection-denybinarypaths) |
| `graphifyQueryTimeoutMs` | No       | `60000`    | Timeout for a `graphify query` subprocess, in milliseconds                              |
| `fetchMaxBytes`          | No       | `10485760` | Default maximum response size for `fetch-binary-file`, in bytes; overridable per call   |
| `fetchTimeoutMs`         | No       | `30000`    | Default request timeout for `fetch-binary-file`, in milliseconds; overridable per call  |
| `readMaxBytes`           | No       | `10485760` | Largest file `read-binary-file` will return, in bytes, measured on disk                 |

Each vault entry can also set its own `denyPaths` and `denyBinaryPaths`, which are
added on top of the global lists for that vault only.

### Path deny list

`denyPaths` stops the MCP client reading or writing specific folders in a vault.
Paths are relative to the vault root and matched as prefixes, so denying `people`
blocks `people/`, `people/alice/notes.md`, and so on.

The top-level `denyPaths` applies to every vault. A vault's own `denyPaths` is added
on top of that global list, restricting that vault further without affecting any
other:

```json
{
  "denyPaths": ["private"],
  "vaults": {
    "knowledge": { "path": "/export/knowledge" },
    "work": { "path": "/export/work", "denyPaths": ["confidential", "drafts"] }
  }
}
```

Here both vaults block `private`, and `work` also blocks `confidential` and
`drafts`.

A blocked request gets a structured MCP error (`isError: true`) rather than a
transport failure, so the client can report the reason clearly. The check happens
before the tool reads or writes any file.

- **Refused when the path you give is denied:** `read-note`, `create-note`,
  `edit-note`, `delete-note`, `move-note` (source and destination),
  `create-binary-file`, `fetch-binary-file`, `read-binary-file`, `delete-binary-file`,
  `move-binary-file` (source and destination), `find-backlinks`, `resolve-wikilink`,
  `add-tags`, `remove-tags`, `set-frontmatter-field`, `remove-frontmatter-field`,
  `create-folder`, and `search-vault` when a `path` scope is given.
- **Filtered as they walk the vault:** `list-notes`, `list-tags`, `search-tags`,
  `new-notes`, `changed-notes` and `rename-tag` leave denied files out of their
  results.
- **Not affected:** `list-vaults` never touches vault files, and `query-graph` does
  not consult the deny list at all.

**`query-graph` can reveal denied content.** It answers from the vault's graphify
knowledge graph and never checks `denyPaths`. If the graph was built over folders
you have denied, its answers can include material from them. Build the graph from a
vault that does not contain the denied content, or leave `query-graph` unused.

The deny list is a coarse guard on what a client can touch. It is not a substitute
for controlling who can reach the server; see [Security](security).

### Binary read protection (`denyBinaryPaths`)

`denyPaths` removes a path from every tool. `denyBinaryPaths` is narrower: it stops
the agent reading a binary file's *contents* with `read-binary-file`, while leaving
the file in place and visible. The agent can still create, move and delete such
files, and `find-backlinks` still sees them. Use it for files you want the agent to
manage but not read, such as scanned documents.

Each entry is a vault-relative path, optionally with wildcards:

| Pattern | Meaning |
| --- | --- |
| `*` | Any run of characters within one path segment (never across a `/`) |
| `?` | Exactly one character within a segment |
| `**` | As a whole segment, any number of segments, including none |

Everything else is matched literally, and there are no character classes, negation
or brace expansion. Matching is case-sensitive, and `*` also matches names that start
with a dot. An entry protects a path it matches and everything under a folder it
matches, so:

| Entry | Protects |
| --- | --- |
| `scans` | `scans/a.pdf`, `scans/2026/b.pdf`; not `scans-old/a.pdf` |
| `scans/*.pdf` | `scans/a.pdf`; not `scans/2026/a.pdf` |
| `*/scans` | `a/scans/x.pdf`; not `scans/x.pdf` or `a/b/scans/x.pdf` |
| `**/*.pdf` | every PDF in the vault, at any depth |
| `private/**` | everything under `private/` |

As with `denyPaths`, the top-level list applies to every vault and a vault's own
list is added to it. A refused read returns `Reading is restricted for '<path>'`.

Protection only works if a protected file can't be relocated, so `move-binary-file`
refuses to move a protected file to a path that is not protected, and the
destination is judged by its final path. With `**/*.pdf` set, renaming `scan.pdf` to
`scan.txt` is refused as well. Moving a file between two protected locations, or
moving an unprotected file into a protected one, is allowed.

The protection also closes the other routes to a protected file's content:

- **`.trash`** is protected automatically whenever any `denyBinaryPaths` are set, in
  that vault. A non-permanent `delete-binary-file` moves a file into `.trash`, so
  without this a protected file could be deleted and then read, or moved out, from
  there. The side effect is that nothing in `.trash` can be read with
  `read-binary-file` while the feature is on.
- **`read-note`** refuses a protected file that is not a `.md` file, since it would
  otherwise return an SVG, CSV or text-layer PDF as text. Markdown notes are never
  affected.
- **`move-note`** applies the same move rule as `move-binary-file` to a source that
  is not a `.md` file, so it can't be used to relocate a protected file.
- **`read-binary-file`** resolves symbolic links before checking. A link is judged by
  where it points: a link to a protected file is refused, and a link to a file outside
  the vault is refused outright.

Apart from those, `denyBinaryPaths` changes nothing: notes stay under `denyPaths`
alone. The other tools still judge a path as given and don't resolve symbolic links.
See [Security](security).
