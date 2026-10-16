---
layout: docs
title: "Tools | obsidian-mcp-brain"
nav_order: 5
---

## Tools

Every tool except `list-vaults` and `get-setup-status` takes a `vault` argument
naming which configured vault the call applies to. Use `list-vaults` to see the
names.

| Tool | Description |
| --- | --- |
| `list-notes` | List the notes in the vault, or scoped to a folder, or other files with `extension` (such as `pdf`, or `*` for every file). Returns sorted vault-relative paths, each with a last-modified timestamp |
| `list-tags` | List all unique tags (YAML frontmatter) used across vault notes, optionally scoped to a subdirectory |
| `search-tags` | Find notes that have ALL of the specified tags |
| `new-notes` | List notes created in the last 7 days, or since a provided timestamp |
| `changed-notes` | List notes modified in the last 7 days, or since a provided timestamp |
| `list-vaults` | List all configured vaults |
| `get-setup-status` | List the companion skills and agents, the server version, and how to install them on each Claude surface |
| `read-note` | Read a note's content and last-modified timestamp |
| `create-note` | Create a new note. Fails if it already exists |
| `edit-note` | Edit a note: append, prepend, replace, replace or delete the content under a heading, or toggle a checkbox |
| `delete-note` | Delete a note, moving it to `.trash` by default |
| `move-note` | Move or rename a note, rewriting all vault-wide wikilinks to the old path |
| `create-binary-file` | Create a new binary file (for example an image) from base64-encoded content. Fails if it already exists |
| `fetch-binary-file` | Create a new binary file by downloading a URL server-side, so the client sends only a URL |
| `upload-binary-file` | Reserve a one-time upload URL for a file of a declared size and SHA-256. The agent sends the file to it with `curl`, so its bytes never pass through the model |
| `read-binary-file` | Return an existing binary file, such as a PDF, to the client as an embedded base64 resource, so the agent can read it |
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
section-scoped edits, so a large note doesn't have to be resent in full for a
small change:

- **`replace-section`** replaces the content under a heading, matched by its
  exact text (without the `#` characters), and leaves the heading line itself in
  place. Everything under the heading goes, sub-sections included, up to the
  next heading of the same or a higher level. `content` is the new body only, so
  don't repeat the heading. To rename a heading, use `replace`. A `content` of
  only spaces, tabs or blank lines clears the section, the same as an empty one.
- **`delete-section`** removes a heading and everything under it, heading line
  and sub-sections included. When the section is the last thing in the note, the
  blank lines before it go too, and the note keeps its final newline if it had
  one.
- **`toggle-checkbox`** flips, or explicitly sets, a `- [ ]` or `- [x]` line,
  matched by its exact text.

If a `heading` or `taskText` matches more than once in the note, the call fails
with a list of every match (line number, and heading level where relevant). Pass
the 1-based `occurrence` from that list on a follow-up call to pick one.

### Wrong arguments

A call that leaves out an argument the tool requires is answered before the tool
runs, with a message that says what to send: the missing arguments, then the
arguments the tool takes (a `*` marks the required ones), then any argument the
tool does not take, which usually explains the miss:

```text
filename is required. read-note takes: vault*, filename*, folder, outline,
heading, occurrence (* required). Unrecognised arguments: path.
```

A missing `vault` also lists the configured vaults, and so does a `vault` the
server does not have: `Unknown vault: x. Available vaults: a, b.` An argument a
tool does not take is not an error when the call is otherwise complete, so a
client that adds fields of its own is unaffected. `create-note` on a note that
already exists points to `edit-note` (append, prepend, replace, replace-section
or delete-section).

### Line endings

A note's line ending is the ending of its first line break: CRLF if that is
`\r\n`, otherwise LF (a note with no line break counts as LF). Every tool that
changes a note writes the text it makes in that ending and leaves the other
lines as they were:

- `edit-note` `append`, `prepend` and `replace-section` convert the line
  breaks of `content` to the note's ending. A note with no line break (an empty
  note, or a single line) has no ending to follow, and `append` and `prepend`
  write `content` as sent.
- `add-tags`, `remove-tags`, `rename-tag`, `set-frontmatter-field` and
  `remove-frontmatter-field` rewrite the frontmatter block in the note's ending,
  and add a block, or a tag line in the body, in it too. The rest of the note is
  not touched.
- In a note that mixes the two, new lines take the first line break's ending and
  the existing lines keep theirs, except that a frontmatter block that is
  rewritten is written in the note's ending throughout.
- `search-vault` returns a matching line without its line ending.

`create-note`, `edit-note` `replace` and `create-binary-file` write exactly what
they are sent, because the caller supplies the whole file.

### Listing files other than notes

`list-notes` lists notes by default. Give it `extension` to list any other kind
of file, so an agent can find the PDFs and images that `read-binary-file`,
`upload-binary-file` and the other binary-file tools work on.

| `extension` | Lists |
| --- | --- |
| *(omitted)* or `md` | The notes: files ending in `.md`, in any letter case |
| `pdf` | Every PDF |
| `p*` | `pdf`, `png` and anything else starting with `p` |
| `*` | Every file, whatever its extension |

- Give the extension without a dot: `pdf`, not `.pdf` or `*.pdf`. `*` matches
  any run of characters and `?` one character.
- Case is ignored, so `jpg` finds `IMG_0001.JPG`.
- The extension is the text after the last dot, so `gz` finds `backup.tar.gz`. A
  file with no extension is listed only by `*`.
- Each line is the vault-relative path, which includes the extension, then the
  last-modified timestamp. `path` scopes the listing to a folder.
- Hidden files and folders (names starting with a dot, such as `.obsidian` and
  `.trash`) and symbolic links are not listed. If `path` is itself a hidden
  folder, only its notes are listed, whatever `extension` says.
- `extension` is at most 64 characters and has no spaces at either end.
- `denyPaths` applies.
  [`denyBinaryPaths`](configuration#binary-read-protection-denybinarypaths) does
  not hide names: it only stops a file's content being read.

### Reading part of a note

`read-note` returns a whole note, which fails for a note too long for the client
to accept (a project spec can reach 100K characters). Rather than return
something the client then rejects, `read-note` refuses a note longer than
[`readNoteMaxChars`](configuration#shape) (50,000 characters by default) and
says how to read it in parts. It takes two extra parameters, named like
`edit-note`'s:

- **`outline: true`** returns the note's headings instead of its content. The
  first line gives the characters, lines and number of headings; each heading
  then has its line range, the size of its section, which occurrence of that
  text it is, and the heading itself:

  ```text
  18420 characters, 312 lines, 3 headings
  lines 1-310 | 18390 chars | occurrence 1 of 1 | # Project
  lines 12-140 | 7210 chars | occurrence 1 of 1 | ## Design
  lines 141-310 | 10980 chars | occurrence 1 of 2 | ## Notes
  ```

- **`heading`**, with `occurrence` if the heading repeats, returns that section:
  the heading line and everything under it up to the next heading of the same or
  a higher level, sub-sections included, without the blank lines that follow it.
  This is the extent `edit-note`'s section operations work on, so a heading from
  the outline can be passed straight to `edit-note`. A section longer than the
  limit is refused too; read one of its sub-sections instead.

`outline` and `heading` can't be used together, `occurrence` needs a `heading`,
and both need a `.md` note. The outline is not subject to the size limit. Both
results carry the `Last-Modified:` timestamp, as a whole-note read does.

Headings inside fenced code blocks are ignored, and notes with Windows (CRLF)
line endings work the same as any other. A line that is only `#` characters and
white space has no text to name it by, so it is not listed and is not a heading:
the section above it runs on through it, and replacing or deleting that section
removes it too.

### Avoiding overwrites with `expectedMtime`

Every tool that writes to an existing file accepts an optional `expectedMtime`:
the ISO 8601 last-modified timestamp you got back earlier from `read-note` or
`list-notes`. Pass it on a later write and the server refuses the write,
changing nothing, if the file has been modified since. The error tells you both
the timestamp you expected and the current one, so you know to read the note
again.

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
`delete-binary-file`; for the two move tools and `delete-binary-file` it is
checked against the source file. `add-tags` and `remove-tags` work on a
`files[]` array, so for them `expectedMtime` is an object mapping each
vault-relative path to its expected timestamp, and it must include every file in
the batch (a file missing from the map fails the call). Every file is checked
before any file is written, so the batch either applies completely or not at
all.

It doesn't apply to `create-note`, `create-binary-file` or `fetch-binary-file`,
which already fail if the destination exists, or to `rename-tag`, which sweeps
the whole vault.

### `fetch-binary-file`

`create-binary-file` needs the client to send the file as base64, which is
costly through an LLM client because the bytes are read in and written out
again. `fetch-binary-file` has the server download a URL itself and write the
result, so the client sends only the URL:

```text
fetch-binary-file -> { filename: "photo.jpg", folder: "attachments", url: "https://example.com/photo.jpg" }
```

The parameters are `filename`, `folder` (optional), `url`, and the optional
`maxBytes` and `timeoutMs`, which must be positive integers and otherwise
default to the config file's `fetchMaxBytes` and `fetchTimeoutMs`. The
`filename` must not end in `.md`; use `create-note` for notes. It fails if the
destination already exists. Because the server makes the request itself, the URL
is checked carefully first. See [Security](security#fetch-binary-file).

### `get-setup-status`

Returns text for the agent: the companion skills and agents that ship with the
server (each with what it is for and which tools it helps), the server's
version, how to tell which Claude surface the agent is on, and the install steps
for each surface. It takes no parameters, touches no vault, and a read-only user
may call it.

The server does not know what a client has installed or which surface it runs
on. The agent compares the list with its own skills and agents, and a skill's
`metadata.version` with the server version, and installs or suggests an update.
The result also says what to do without the skills: `read-binary-file` shows
only images on a chat surface, and `upload-binary-file` needs a shell and
`curl`, which Claude Code can refuse until the user allows the skill's script
with a permission rule. See [Agent skills and
agents](connect#agent-skills-and-agents).

### `read-binary-file`

The other binary tools can create, move and delete a file but not hand its
contents to the agent. `read-binary-file` does that: it returns the file as two
content blocks, a short text line
(`attachments/report.pdf (48213 bytes, application/pdf)`) followed by an MCP
embedded `resource` carrying the file's bytes as base64, its `mimeType`, and a
`file:///` URI built from the vault-relative path.

```text
read-binary-file -> { filename: "report.pdf", folder: "attachments" }
```

The parameters are `filename` and `folder` (optional). The `filename` must not
end in `.md`; use `read-note` for notes. The file's size is checked before it is
read, and a file larger than the config file's
[`readMaxBytes`](configuration#shape) (10 MiB by default) is refused without
being loaded. There is no per-call override.

A large file that has not been read recently, a scanned PDF of a few MB for
example, can fail on the first call with a client-side timeout such as
`The operation timed out`. The server received the request and was still reading
the file; the response is the file plus a third again for base64, and the
client's own request timeout is the limit. A retry is then fast because the file
is cached. The tool's description tells an agent to retry up to twice before
reporting a failure. If a client times out on every attempt, lower
`readMaxBytes` so such files are refused outright instead.

The server does not interpret the file. It never parses a PDF, extracts text,
renders pages or runs OCR, so it needs no extra software. The client does that
work, which is why one tool covers a PDF with a real text layer and a scanned
PDF whose text is only in page images: a client that can read a PDF handles
both. The `mimeType` comes from the file extension (`pdf`, `png`, `jpg`/`jpeg`,
`gif`, `webp` and `svg` are recognised), and anything else is
`application/octet-stream`.

The path must pass the [`denyPaths`](configuration#path-deny-list) check, and it
must not be covered by
[`denyBinaryPaths`](configuration#binary-read-protection-denybinarypaths), which
refuses with `Reading is restricted for '<path>'` while leaving the file visible
to the other tools. To stop a protected file being read from somewhere else,
`move-binary-file` (and `move-note`, for a file that isn't a `.md` file) refuses
to move it to a path that is not protected. Moving it within the protected area,
or moving an unprotected file in, is allowed. Symbolic links are resolved before
the checks, and only regular files are returned.

How the file reaches the model depends on the client; see [Reading PDFs and
other binary files](connect#reading-pdfs-and-other-binary-files). Claude Code
reads any file this way. Claude Desktop chat shows images but silently drops a
PDF and rejects other types, so use a code mode chat there. The repository
includes an agent skill,
[`skills/read-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/read-binary-file),
that checks this before reading and tells the user what to do.

### `upload-binary-file`

`create-binary-file` needs the model to write the whole file out as base64. That
is impractical beyond a few tens of kilobytes (an 810 KB PDF is about a million
tokens, more than one response can hold) and gives no way to tell whether the
file arrived intact. `upload-binary-file` gives the agent a one-time URL to send
the file to directly, so the file's bytes never pass through the model.

The flow:

1. The agent works out the file's size and SHA-256 with a tool (`wc -c`,
   `sha256sum`), never by hand.
2. It calls the tool:

   ```text
   upload-binary-file -> { filename: "report.pdf", folder: "attachments", size: 810490, sha256: "<64 hexadecimal characters>" }
   ```

3. The result holds a URL of the form `https://server:4001/up/<random token>`,
   when it expires, and a ready-to-run command.
4. The agent runs it: `curl --fail-with-body -sS -T report.pdf "<url>"`.
5. The server checks the received bytes against the declared size and hash. If
   both match it places the file at the destination and answers with
   `{"path", "bytes", "sha256"}`. If not, it discards the file and says why.

The address part of the URL (`https://server:4001` above) is the config file's
`mcpBaseUrl`; `/up/` is always the same and only the token after it is secret
and random.

The rules:

- **One request only.** The first request that names the URL uses it up,
  whatever it turns out to be: a wrong address, a wrong method, a bad
  `Content-Length` or a hash mismatch all kill it just as a good upload does. If
  anything goes wrong, call the tool again for a new URL.
- **Same address.** The upload must come from the same network address as the
  call that reserved it, or, with
  [`uploadNetworkPrefix`](configuration#uploads-and-reverse-proxies) set below
  32, from an IPv4 address in the same network. Behind a reverse proxy this
  needs `trustedProxies`; see
  [Configuration](configuration#uploads-and-reverse-proxies).
- **Short-lived.** A URL lasts `uploadTtlSeconds` (300 by default).
- **The destination.** The destination must not already exist, and it must pass
  the [`denyPaths`](configuration#path-deny-list) check, both when the URL is
  reserved and again when the file is placed, after following any symbolic
  links, so a link that leads out of the vault, or into a denied folder, is
  refused. Missing folders are created.
- **Notes.** A `.md` destination is accepted. Use this for a large or generated
  note that is already on disk, such as an Excalidraw drawing, so that its text
  doesn't pass through the model; use `create-note` for text the agent has
  written itself. A note is placed only if the received file is valid UTF-8,
  otherwise it is discarded with a `400` that says why. Everything else about
  the upload is the same as for any other file.
- **Limits.** The declared `size` can be at most `uploadMaxBytes` (50 MiB by
  default). At most 16 URLs can be pending and 4 uploads in progress at once.
- **Nothing is left behind.** A file that is rejected, interrupted or stalled
  leaves nothing in the vault and nothing in the staging folder.

What `curl` receives:

| Code | Meaning |
| --- | --- |
| `201` | The file was received, matched, and placed. The body is `{"path", "bytes", "sha256"}` |
| `400` | The `Content-Length` was smaller than the declared size, or the destination is a note (`.md`) and the file is not valid UTF-8 |
| `403` | The request came from a different address (or network), carried an `Origin` header, or the destination is denied |
| `404` | The URL is unknown, already used or expired (the same answer in every case) |
| `405` | The request was not a `PUT` |
| `409` | The destination appeared after the URL was reserved |
| `411` | No `Content-Length` was sent (chunked uploads are refused) |
| `413` | The `Content-Length` was larger than the declared size |
| `422` | The received bytes did not match the declared SHA-256. The file was discarded |
| `503` | Too many uploads are already in progress. Request a new URL and try again shortly |

Because of `--fail-with-body`, `curl` exits with code 22 on any of the error
codes and prints the server's explanation, which is what makes a failure
readable.

This needs an agent with a shell on a machine that can reach the server's
address, such as Claude Code. A client without a shell, or whose network can't
reach the server, can't use it, and falls back to `create-binary-file` for small
files. A client whose tool call and upload leave from different addresses, such
as Claude Desktop chat or claude.ai, is refused with `403` unless
`uploadNetworkPrefix` is set.

The server writes one line to its log for every refused upload, with the
status, the caller's address and the reason, for example `upload refused (403)
from 203.0.113.7: the caller address 203.0.113.7 is not the same as the address
that reserved the URL, 198.51.100.2`. With `uploadNetworkPrefix` set, it says
"is not in the same /21 network as" (with the number set) instead. The answer
to the client is deliberately shorter. The URL is never logged.

The repository includes an agent skill,
[`skills/upload-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/upload-binary-file),
that does steps 1 and 4 for the agent. Its script,
`scripts/upload-binary-file.sh`, has `prepare <file>` (prints the file name,
size and SHA-256) and `send <file> <url>` (uploads, then compares the server's
reply with the local file and never prints the token). It needs `curl` and one
of `sha256sum`, `shasum` or `openssl`. The npm package contains only the server,
so copy the skill folder into your agent's skills directory (for Claude Code,
`~/.claude/skills/`) to use it, or install the plugin; see [Agent skills and
agents](connect#agent-skills-and-agents). The tool works without the skill. See
[Security](security#upload-binary-file) for what the URL does and doesn't
protect.
