---
layout: docs
title: "Tools | obsidian-mcp-brain"
nav_order: 5
---

## Tools

Every tool except `list-vaults` takes a `vault` argument naming which configured
vault the call applies to. Use `list-vaults` to see the names.

| Tool | Description |
| --- | --- |
| `list-notes` | List all notes in the vault, or scoped to a folder. Returns sorted vault-relative paths, each with a last-modified timestamp |
| `list-tags` | List all unique tags (YAML frontmatter) used across vault notes, optionally scoped to a subdirectory |
| `search-tags` | Find notes that have ALL of the specified tags |
| `new-notes` | List notes created in the last 7 days, or since a provided timestamp |
| `changed-notes` | List notes modified in the last 7 days, or since a provided timestamp |
| `list-vaults` | List all configured vaults |
| `read-note` | Read a note's content and last-modified timestamp |
| `create-note` | Create a new note. Fails if it already exists |
| `edit-note` | Edit a note: append, prepend, replace, replace or delete the content under a heading, or toggle a checkbox |
| `delete-note` | Delete a note, moving it to `.trash` by default |
| `move-note` | Move or rename a note, rewriting all vault-wide wikilinks to the old path |
| `create-binary-file` | Create a new binary file (for example an image) from base64-encoded content. Fails if it already exists |
| `fetch-binary-file` | Create a new binary file by downloading a URL server-side, so the client sends only a URL |
| `move-binary-file` | Move or rename a binary file, rewriting all vault-wide wikilink embeds pointing at the old path |
| `delete-binary-file` | Delete a binary file, moving it to `.trash` by default |
| `find-backlinks` | Find all notes that link to or embed a given note or binary file |
| `resolve-wikilink` | Resolve a wikilink target string to the vault-relative file or files it points to |
| `create-folder` | Create a new folder, and any missing parents, in the vault |
| `search-vault` | Search vault notes by content, filename, or both |
| `add-tags` | Add tags to notes in frontmatter and/or inline body content |
| `remove-tags` | Remove tags from notes in frontmatter and/or inline body content |
| `rename-tag` | Rename a tag throughout the entire vault, in frontmatter and inline |
| `set-frontmatter-field` | Set a single frontmatter field (not `tags`) to a scalar value, creating it if missing |
| `remove-frontmatter-field` | Remove a single frontmatter field (not `tags`) entirely |
| `query-graph` | Ask a natural-language question against a vault's graphify knowledge graph |

### `edit-note` operations

Beyond `append`, `prepend` and `replace`, `edit-note` supports targeted,
section-scoped edits, so a large note doesn't have to be resent in full for a small
change:

- **`replace-section`** replaces the content under a heading, matched by its exact
  text, and leaves the heading line itself in place.
- **`delete-section`** removes a heading and everything under it, heading line
  included.
- **`toggle-checkbox`** flips, or explicitly sets, a `- [ ]` or `- [x]` line,
  matched by its exact text.

If a `heading` or `taskText` matches more than once in the note, the call fails
with a list of every match (line number, and heading level where relevant). Pass
the 1-based `occurrence` from that list on a follow-up call to pick one.

### Avoiding overwrites with `expectedMtime`

Every tool that writes to an existing file accepts an optional `expectedMtime`: the
ISO 8601 last-modified timestamp you got back earlier from `read-note` or
`list-notes`. Pass it on a later write and the server refuses the write, changing
nothing, if the file has been modified since. The error tells you both the
timestamp you expected and the current one, so you know to read the note again.

It is a compare-and-swap check, not a lock. It catches "I read this note a while
ago and something else has touched it since". A client that reads, decides, then
writes back should always pass it, otherwise an edit made in between is silently
overwritten.

```text
read-note  -> note content + Last-Modified: 2026-09-20T10:15:00.000Z
...decide what to change...
edit-note  -> { operation: "replace", content: "...", expectedMtime: "2026-09-20T10:15:00.000Z" }
```

It applies to `edit-note` (all operations), `delete-note`, `move-note`,
`set-frontmatter-field`, `remove-frontmatter-field`, `move-binary-file` and
`delete-binary-file`; for the two move tools and `delete-binary-file` it is checked
against the source file. `add-tags` and `remove-tags` work on a `files[]` array, so
for them `expectedMtime` is an object mapping each vault-relative path to its
expected timestamp, and it must include every file in the batch (a file missing
from the map fails the call). Every file is checked before any file is written, so
the batch either applies completely or not at all.

It doesn't apply to `create-note`, `create-binary-file` or `fetch-binary-file`,
which already fail if the destination exists, or to `rename-tag`, which sweeps the
whole vault.

### `fetch-binary-file`

`create-binary-file` needs the client to send the file as base64, which is costly
through an LLM client because the bytes are read in and written out again.
`fetch-binary-file` has the server download a URL itself and write the result, so
the client sends only the URL:

```text
fetch-binary-file -> { filename: "photo.jpg", folder: "attachments", url: "https://example.com/photo.jpg" }
```

The parameters are `filename`, `folder` (optional), `url`, and the optional
`maxBytes` and `timeoutMs`, which must be positive integers and otherwise default
to the config file's `fetchMaxBytes` and `fetchTimeoutMs`. The `filename` must not
end in `.md`; use `create-note` for notes. It fails if the destination already
exists. Because the server makes the request itself, the URL is checked carefully
first. See [Security](security#fetch-binary-file).
