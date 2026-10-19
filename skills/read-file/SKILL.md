---
name: read-file
description: Read a PDF, image or other non-note file from an Obsidian vault through the obsidian-mcp-brain server's read-file tool. Use whenever the user asks to read, open, summarise or look at a PDF, image or other non-markdown file that is in the vault. It first checks which Claude surface it is running on, because Claude chat surfaces show only images and silently drop other file types.
metadata:
  version: "1.5.2"
---

# Read a non-note file from the vault

`read-file` returns a file as an MCP embedded `resource` block (base64
bytes and a MIME type). What happens next depends on the client:

- **Claude Code** (including the code mode of the Claude Desktop app) saves the
  bytes to a file and gives you its path. You then open that path with your
  file-reading tool, which reads PDFs.
- **Claude Desktop chat** passes an embedded resource to the model only if it is
  an image. A PDF is dropped without any error, and a text file such as a CSV is
  rejected with `The tool returned an image in an unsupported format.` (tested).
  claude.ai chat is reported to behave the same way but has not been tested
  here. As far as we can tell this is the client's behaviour, so nothing the
  server does changes it, and retrying does not help.

So check where you are before reading anything that is not an image.

## Step 1: work out which surface you are on

Look at where this skill file was loaded from and at the home directory:

| This skill is found at | Surface | Reading a non-image file |
| --- | --- | --- |
| `~/.claude/skills/read-file/`, or a folder under `~/.claude/plugins/` (an installed plugin), under a home that is not `claude` (`/home/<user>`, `/Users/<user>`) | Claude Code | Works. Go to step 2 |
| `/mnt/skills/user/...` or `/mnt/skills/plugins/...`, or the home directory is `/home/claude` | Claude Desktop chat or claude.ai chat | Does not work (tested in Desktop chat, reported for claude.ai). Stop and tell the user (below) |
| `/root/.claude/skills/synced/<bucket-id>/...` | Cowork | Not tested. Go to step 2 and rely on the check in step 3 |

If you cannot tell, go to step 2 and use the check in step 3.

**An image is expected to be fine on every surface** (WebP was tested in Claude
Desktop chat; PNG, JPEG and GIF are the other formats reported to be shown).
Only stop for a file that is not an image. Treat SVG as a non-image: it is not
one of those formats.

When you stop, say this to the user, with the file name filled in:

> `<file>` is a PDF (or other non-image file), and this chat can't show
> non-image files from the vault: it drops them without an error. Open the vault
> in a Claude Code chat (in the Claude Desktop app, the code mode) and ask
> there; the same MCP server works in it.

Do not try to work around it by base64-encoding the file into a message, or by
calling `read-file` repeatedly.

## Step 2: find and read the file

1. If you do not know the path, call `list-files` (give `extension`, for example
   `pdf`, and, optionally, `path` to narrow it to a folder).
2. Call `read-file` with `vault`, `filename` and `folder`. A `.md` note
   can be read too, but `read-note` is better for a note.
3. In Claude Code, the result gives a saved path. Open it with your file-reading
   tool. A PDF with a text layer is read as text, and a scanned PDF is read from
   rendered page images.

## Step 3: check the result

- **A text line and a file you can open**: you are done. The `sha256:` and
  `Last-Modified:` lines name the version you read; the `replace-file`
  skill needs them to replace the file.
- **Only the text lines** (`<path> (<n> bytes, <mime type>)`, then `sha256:` and
  `Last-Modified:`) and no file or content, for a file that is not an image:
  this surface drops non-image files. Stop and tell the user as in step 1. Do
  not call the tool again.
- **`The operation timed out`** on a large file that has not been read recently:
  the server is still working and a second call is fast. Call it again, up to
  twice, then tell the user.
- **`Reading is restricted for '<path>'`**: the owner has protected the file.
  Tell the user; do not look for another way to read it.
- **The file is larger than the limit**: the message says so. Tell the user.

## Rules

- Do not guess a file's contents from its name when the read did not work. Say
  that you could not read it.
- Do not move or copy the file to another name or location to try again: the
  failure is about the file's type and the client, not its name or size.
