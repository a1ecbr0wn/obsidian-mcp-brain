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
  "mcpBaseUrl": "https://your-hostname:4001",
  "denyPaths": ["private"],
  "graphifyQueryTimeoutMs": 60000,
  "fetchMaxBytes": 10485760,
  "fetchTimeoutMs": 30000,
  "vaults": {
    "knowledge": {
      "path": "/path/to/your/obsidian/vault"
    },
    "work": {
      "path": "/path/to/another/vault",
      "denyPaths": ["confidential"]
    }
  }
}
```

| Field                    | Required | Default    | Description                                                                             |
| ------------------------ | -------- | ---------- | --------------------------------------------------------------------------------------- |
| `mcpBaseUrl`             | Yes      | none       | Public HTTPS base URL of the server, used in OAuth responses and SSE endpoint events    |
| `vaults`                 | Yes      | none       | Non-empty object of `{ "name": { "path": "..." } }`. Each vault needs at least a `path` |
| `listenPort`             | No       | `3002`     | Local port the server listens on                                                        |
| `denyPaths`              | No       | `[]`       | Vault-relative paths to block, applied to every vault                                   |
| `graphifyQueryTimeoutMs` | No       | `60000`    | Timeout for a `graphify query` subprocess, in milliseconds                              |
| `fetchMaxBytes`          | No       | `10485760` | Default maximum response size for `fetch-binary-file`, in bytes; overridable per call   |
| `fetchTimeoutMs`         | No       | `30000`    | Default request timeout for `fetch-binary-file`, in milliseconds; overridable per call  |

Each vault entry can also set its own `denyPaths`, which are added on top of the
global list for that vault only.

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
  `create-binary-file`, `fetch-binary-file`, `delete-binary-file`,
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
