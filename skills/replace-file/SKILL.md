---
name: replace-file
description: Replace a file that is already in an Obsidian vault (a PDF, image or other binary) with a new version from the local disk, through the obsidian-mcp-brain server's replace-file tool, without base64-encoding it. Use whenever the user asks to update, overwrite or replace a vault file with a local one, and the server offers replace-file.
metadata:
  version: "1.5.0"
---

# Replace a vault file with a local one

`replace-file` swaps a file in the vault for a new local version. It
reserves a one-time URL on the MCP server; the new file then goes straight from
disk to the server with `curl`, so its bytes never pass through you. The server
refuses the replacement unless the file in the vault is still the version you
say you are replacing, and it moves the old version to `.trash`, where it
stays for 30 days by default (the server's `trashRetentionDays`) before it is
deleted. To add a file that is not in the vault yet, use the
`upload-file` skill.

This workflow needs a shell on a machine that can reach the MCP server, and
`read-file` to learn which version is in the vault.

## Steps

Run the helper from this skill's directory: `scripts/replace-file.sh`.

1. **Read the version in the vault.** Call `read-file` for the file. Its
   result ends with a `sha256:` line and a `Last-Modified:` line: these are
   `expectedSha256` and `expectedMtime`. If the file is too large to read, the
   refusal message gives both values. You do not need to open the file.
2. **Prepare.**
   `sh scripts/replace-file.sh prepare "<path to the new local file>"`
   prints `filename=`, `size=` and `sha256=` of the new file.
3. **Reserve.** Call the `replace-file` tool with `vault`, `filename` and
   `folder` of the file in the vault, `size` and `sha256` exactly as `prepare`
   printed, and `expectedSha256` and `expectedMtime` from step 1. The result
   contains a one-time URL.
4. **Send.**
   `sh scripts/replace-file.sh send "<new file>" "<the URL>" "<expectedSha256>"`.
   It uploads the file, checks the server's reply against the local file and
   against the version you expected, and prints `replaced <vault path> ...
   verified against the local file; the old version ... is in .trash/...`.

Do steps 2 to 4 back to back. The URL expires after a few minutes and works once.

## Rules

- **Never work out a hash or size by hand**, and never paste the file's contents
  into a tool call. Use `prepare` for the new file and copy `expectedSha256` and
  `expectedMtime` from `read-file` as they are printed.
- **Read the file in the vault yourself, just before.** Do not reuse values from
  earlier in the conversation or from the user: if the file has changed since,
  the replacement is refused, which is what the check is for.
- **Do not reuse a URL.** Any request to it, even a failed one, uses it up.
  Call `replace-file` again for a new one.
- **Do not share or log the URL.** The helper never prints it.
- **Tell the user where the old version went.** The helper prints its `.trash`
  path; `move-file` can put it back, but only until the server empties
  `.trash` (30 days by default).

## When it fails

| The tool or helper reports | Meaning | What to do |
| --- | --- | --- |
| `File does not exist` | Nothing at that path to replace | Check the name with `list-notes` and its `extension` option, or use `upload-file` for a new file |
| `Precondition failed`, or `409` saying the file has changed | The vault file is no longer the version you named, or it changed after you reserved | Run `read-file` again, tell the user the file changed, and ask before replacing the newer version |
| `nothing to replace` | The new file is identical to the one in the vault | Nothing to do; tell the user |
| `Reading is restricted` or `Access denied` | The path is protected | Tell the user; do not look for another route |
| `404` | The URL expired or was already used | Reserve a new URL (step 3) and send again |
| `403` | The request carried an `Origin` header, came from a different address from the one that reserved it (only when the server checks that), or the destination is not allowed | Check the machine that ran `send` is connected to the server; if the path is restricted, tell the user |
| `422` | The file does not match the declared hash (it changed, or was damaged) | Run `prepare` again, then reserve a new URL |
| `400` saying a note must be valid UTF-8 | The file is a `.md` note whose bytes are not UTF-8 text | Fix the encoding, or tell the user; do not send it under another extension |
| `411`, `413` or `400` | The declared size does not match the file, or exceeds the upload limit | Run `prepare` again; if the file is over the limit, tell the user |
| `503` | Too many uploads in progress | Wait a few seconds and start again from step 3 |
| curl could not connect | The URL's address is not reachable from this machine | Tell the user: the server's `mcpBaseUrl` may be wrong for this client |

Report any other failure to the user with the message the helper printed.
