---
name: upload-binary-file
description: Put a local file (a PDF, image or other binary) into an Obsidian vault through the obsidian-mcp-brain server's upload-binary-file tool, without base64-encoding it. Use whenever the user asks to add, save, file or upload a local file to the vault, and the file is more than a few KB or the server offers upload-binary-file.
---

# Upload a local file to the vault

`upload-binary-file` reserves a one-time URL on the MCP server; the file then goes straight
from disk to the server with `curl`, so its bytes never pass through you. Use this instead of
`create-binary-file`, which needs the whole file as base64 text in a tool call. That is slow,
costs a large number of tokens, and a single wrong character corrupts the file.

This workflow needs a shell on a machine that can reach the MCP server. If you have no shell,
use `create-binary-file` for small files and tell the user it is not possible for large ones.

## Steps

Run the helper from this skill's directory: `scripts/upload-binary-file.sh`.

1. **Prepare.** `sh scripts/upload-binary-file.sh prepare "<path to the local file>"` prints
   `filename=`, `size=` and `sha256=` lines.
2. **Reserve.** Call the `upload-binary-file` tool with `vault`, `filename`, `size` and `sha256`
   exactly as printed, plus `folder` for where it should go in the vault. The result contains a
   one-time URL.
3. **Send.** `sh scripts/upload-binary-file.sh send "<path to the local file>" "<the URL>"`.
   It uploads the file, then checks the server's reply against the local file and prints
   `uploaded <vault path> ... verified against the local file` on success.

Do the three steps back to back. The URL expires after a few minutes and works once.

## Rules

- **Never work out the hash or size by hand**, and never paste the file's contents into a tool
  call. Use `prepare`; it is the only source for `size` and `sha256`.
- **Do not reuse a URL.** Any request to it, even a failed one, uses it up. Call
  `upload-binary-file` again for a new one.
- **Do not share or log the URL.** The helper never prints it.
- **Choose the destination before reserving.** An upload never overwrites: the name must not
  already exist in the vault.

## When it fails

| The helper reports | Meaning | What to do |
|---|---|---|
| `404` | The URL expired or was already used | Reserve a new URL (step 2) and send again |
| `403` | The request came from a different address from the one that reserved it, or the destination is not allowed | Check the machine that ran `send` is the one that is connected to the server; if the path is restricted, tell the user |
| `409`, or the tool itself says the file already exists | The destination exists (or appeared after the URL was reserved) | Choose another filename or folder, or ask the user; there is no overwrite |
| `422` | The file does not match the declared hash (it changed, or was damaged) | Run `prepare` again, then reserve a new URL |
| `411`, `413` or `400` | The declared size does not match the file, or exceeds the upload limit | Run `prepare` again; if the file is over the limit, tell the user |
| `503` | Too many uploads in progress | Wait a few seconds and start again from step 2 |
| curl could not connect | The URL's address is not reachable from this machine | Tell the user: the server's `mcpBaseUrl` may be wrong for this client |

Report any other failure to the user with the message the helper printed.

## Reading the file back

To check the upload or read a PDF afterwards, use `read-binary-file`, then open the saved path it
returns with your file-reading tool. If it times out on a large file, call it again.
