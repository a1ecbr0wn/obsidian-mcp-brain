---
layout: docs
title: "Connect a Client | obsidian-mcp-brain"
nav_order: 4
---

## Connect a client

Use the HTTPS address you exposed the server on (see
[Tailscale Serve](install/install-tailscale)) with `/mcp` on the end.

### Claude Code

Add the server to your Claude Code config (`~/.claude.json`, or with
`claude mcp add`):

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "https://your-hostname:4001/mcp"
    }
  }
}
```

Claude Code prompts you to authenticate the first time. Click through the OAuth
flow: it uses a public, no-credentials token, so no real account is needed.

### Claude Desktop

Servers added through `claude_desktop_config.json` are launched by Claude Desktop
as local stdio subprocesses, so reaching a remote server that way needs a small
relay that turns its stdio traffic into HTTP calls against the server's `/mcp`
endpoint. There are two options.

**`mcp-remote` through `npx`** is the quickest: nothing to install and no local
files. It suits a plain, no-credentials setup like this server's.

Edit `claude_desktop_config.json` (in Claude Desktop, **Settings → Developer → Edit
Config**) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://your-hostname:4001/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop after saving.

**`mcp-shim`** is a zero-dependency relay script in this project's repository. Use
it if you need a bearer token, a custom request timeout, or you don't want an
`npx` download every time Claude Desktop starts. It isn't published to npm, so
clone the repository and point Claude Desktop at the script:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp-brain/mcp-shim/mcp-shim.mjs"],
      "env": {
        "MCP_URL": "https://your-hostname:4001/mcp"
      }
    }
  }
}
```

It needs Node.js 18 or later and is configured with environment variables:

| Variable      | Required | Default | Description                                                                                        |
| ------------- | -------- | ------- | -------------------------------------------------------------------------------------------------- |
| `MCP_URL`     | Yes      | none    | Full `https://` URL of the remote MCP endpoint. It can also be passed as the first argument to the script |
| `MCP_TOKEN`   | No       | none    | Bearer token sent with every request as `Authorization: Bearer TOKEN`                              |
| `MCP_TIMEOUT` | No       | `60000` | Timeout in milliseconds for POST and DELETE requests. The SSE stream has no timeout                |

The shim uses HTTPS only, so an `http://` URL such as `http://localhost:3002/mcp`
will not work through it. It forwards each JSON-RPC message from Claude Desktop as
an HTTPS POST to `MCP_URL`, opens a persistent SSE stream for server-initiated
messages once the server has issued a session ID, reconnects that stream with
exponential backoff if it drops, and sends an HTTP DELETE to end the session
cleanly when Claude Desktop exits.

### Reading PDFs and other binary files

`read-binary-file` returns a file as an MCP embedded resource, and what a client does
with that is up to the client.

- **Claude Code** doesn't put the bytes into the conversation. It saves the file
  under its own tool-results directory and tells the agent the path, and the agent
  then opens that path with its `Read` tool, which reads PDFs. A PDF with a real text
  layer is read as text, and an image-only (scanned) PDF is read from rendered page
  images. Both were checked end to end. Because the bytes don't travel as text, a
  large PDF costs the model's normal per-page PDF cost.
- **Claude Desktop chat** passes an embedded resource to the model only when it is an image
  (claude.ai chat is reported to do the same, and has not been tested here). WebP images were shown; a PDF was dropped with no
  error and no content, whatever its size (621 bytes to 660 KB) or name; a CSV was refused
  with `The tool returned an image in an unsupported format.` The server's reply is valid
  MCP, so this is how the client treats the result, and retrying does not help. The same
  server works in Claude Code, including the code mode of the Claude Desktop app, so
  use a code mode chat to read PDFs and other non-image files.
- **Other clients** have not been checked. A client that does nothing useful with an
  embedded resource can't read files this way.

The repository includes an agent skill,
[`skills/read-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/read-binary-file),
that works out which Claude surface it is running on, and on a chat surface tells the user
that a non-image file can't be shown and suggests a code mode chat, instead of the agent
reporting an empty result. It is only effective where it is installed; see
[Agent skills](#agent-skills).

The server never extracts text itself, so it behaves the same whichever client
connects.

### Uploading files

[`upload-binary-file`](tools#upload-binary-file) gives the agent a URL to send a file to with
`curl`, so the file doesn't pass through the model. It therefore needs an agent that can
run commands on a machine that can reach the server's address (`mcpBaseUrl`).

- **Claude Code** has a shell, so it can use it directly.
- **Clients without a shell**, such as Claude Desktop chat, can't run `curl` themselves,
  and clients that call the server from the vendor's cloud need the server to be
  reachable from there. Neither was tested. They can still use `create-binary-file` for
  small files.

### Agent skills

The repository ships two agent skills,
[`read-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/read-binary-file)
and [`upload-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/upload-binary-file).
The tools work without them; the skills tell an agent how to use the tools well and, in
`read-binary-file`'s case, what to say when the client can't show a file. They are packaged
as a plugin and as individual `.skill` files. How you get them depends on where you run Claude:

| Where | How |
|---|---|
| Claude Code, including the code mode of the Claude Desktop app | `/plugin marketplace add a1ecbr0wn/obsidian-mcp-brain`, then `/plugin install obsidian-mcp-brain@obsidian-mcp-brain` |
| Cowork | Add the `obsidian-mcp-brain.plugin` file from the [latest release](https://github.com/a1ecbr0wn/obsidian-mcp-brain/releases/latest) |
| Claude Desktop chat and claude.ai | Upload a `.skill` file from the latest release in **Settings → Capabilities → Skills** |
| Anywhere else | Copy a folder from `skills/` into your agent's skills directory (for Claude Code, `~/.claude/skills/`) |

A plugin marketplace is a Claude Code and Cowork feature, so the chat surfaces need the
`.skill` upload. `upload-binary-file` needs a shell on a machine that can reach the server, so
it is of use only where the agent has one. The `.skill` and `.plugin` files are built from the repository by
`scripts/package-skills.sh`, which needs only `zip`, and are attached to each release.
