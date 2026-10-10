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
- **Other clients**, including Claude Desktop, have not been checked. A client that
  does nothing useful with an embedded resource can't read files this way.

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
