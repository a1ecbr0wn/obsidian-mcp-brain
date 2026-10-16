---
layout: docs
title: "Connect a Client | obsidian-mcp-brain"
nav_order: 4
---

## Connect a client

Use the HTTPS address you exposed the server on (see [Tailscale
Serve](install/install-tailscale), [nginx](install/install-nginx) or
[Caddy](install/install-caddy)) with `/mcp` on the end.

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

Claude Code prompts you to authenticate the first time. On an unauthenticated
server click through the OAuth flow: it uses a public, no-credentials token, so
no real account is needed. When the server has
[`auth`](configuration#authentication-auth) set, the same flow sends you to your
OAuth service's login page, and the token you get is checked by the server.

### Claude Desktop

Servers added through `claude_desktop_config.json` are launched by Claude
Desktop as local stdio subprocesses, so reaching a remote server that way needs
a small relay that turns its stdio traffic into HTTP calls against the server's
`/mcp` endpoint. There are two options.

**`mcp-remote` through `npx`** is the quickest: nothing to install and no local
files. It suits a plain, no-credentials setup like this server's.

Edit `claude_desktop_config.json` (in Claude Desktop, **Settings → Developer →
Edit Config**) and add an entry under `mcpServers`:

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

**`mcp-shim`** is a zero-dependency relay script in this project's repository.
Use it if you need a bearer token, a custom request timeout, or you don't want
an `npx` download every time Claude Desktop starts. It isn't published to npm,
so clone the repository and point Claude Desktop at the script:

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

| Variable      | Required | Default | Description                                                                                               |
| ------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `MCP_URL`     | Yes      | none    | Full `https://` URL of the remote MCP endpoint. It can also be passed as the first argument to the script |
| `MCP_TOKEN`   | No       | none    | Bearer token sent with every request as `Authorization: Bearer TOKEN`                                     |
| `MCP_TIMEOUT` | No       | `60000` | Timeout in milliseconds for POST and DELETE requests. The SSE stream has no timeout                       |

The shim uses HTTPS only, so an `http://` URL such as
`http://localhost:3002/mcp` will not work through it. It forwards each JSON-RPC
message from Claude Desktop as an HTTPS POST to `MCP_URL`, opens a persistent
SSE stream for server-initiated messages once the server has issued a session
ID, reconnects that stream with exponential backoff if it drops, and sends an
HTTP DELETE to end the session cleanly when Claude Desktop exits.

### Reading PDFs and other binary files

`read-binary-file` returns a file as an MCP embedded resource, and what a client
does with that is up to the client.

- **Claude Code** doesn't put the bytes into the conversation. It saves the file
  under its own tool-results directory and tells the agent the path, and the
  agent then opens that path with its `Read` tool, which reads PDFs. A PDF with
  a real text layer is read as text, and an image-only (scanned) PDF is read
  from rendered page images. Both were checked end to end. Because the bytes
  don't travel as text, a large PDF costs the model's normal per-page PDF cost.
- **Claude Desktop chat** passes an embedded resource to the model only when it
  is an image (claude.ai chat is reported to do the same, and has not been
  tested here). WebP images were shown; a PDF was dropped with no error and no
  content, whatever its size (621 bytes to 660 KB) or name; a CSV was refused
  with `The tool returned an image in an unsupported format.` The server's reply
  is valid MCP, so this is how the client treats the result, and retrying does
  not help. The same server works in Claude Code, including the code mode of the
  Claude Desktop app, so use a code mode chat to read PDFs and other non-image
  files.
- **Other clients** have not been checked. A client that does nothing useful
  with an embedded resource can't read files this way.

The repository includes an agent skill,
[`skills/read-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/read-binary-file),
that works out which Claude surface it is running on, and on a chat surface
tells the user that a non-image file can't be shown and suggests a code mode
chat, instead of the agent reporting an empty result. It is only effective where
it is installed; see [Agent skills and agents](#agent-skills-and-agents).

The server never extracts text itself, so it behaves the same whichever client
connects.

### Uploading files

[`upload-binary-file`](tools#upload-binary-file) gives the agent a URL to send a
file to with `curl`, so the file doesn't pass through the model. It therefore
needs an agent that can run commands on a machine that can reach the server's
address (`mcpBaseUrl`).

- **Claude Code** has a shell, so it can use it directly.
- **Clients without a shell**, such as Claude Desktop chat, can't run `curl`
  themselves, and clients that call the server from the vendor's cloud need the
  server to be reachable from there. Neither was tested. They can still use
  `create-binary-file` for small files.

### When the server has authentication on

With [`auth`](configuration#authentication-auth) set, every client needs a token
for a user the server lists. How each one gets it:

| Client | How it signs in |
| --- | --- |
| Claude Code | Follows the server's discovery documents to your OAuth service, opens the login in a browser and keeps the token; `/mcp` is where you sign in again |
| Claude Desktop with `mcp-remote` | Runs the OAuth flow itself the first time it connects: opens your browser to the login page, receives the code on a local address, and caches the token on that machine. No change to the config entry is needed |
| Claude Desktop with `mcp-shim` | The shim sends a fixed token from `MCP_TOKEN` and cannot refresh it, so it suits only an issuer that can hand out a long-lived token. Prefer `mcp-remote` |
| claude.ai and the Claude mobile app | Add the server as a custom connector with its public `/mcp` address. The connector runs the sign-in flow from the vendor's cloud, so the server must be reachable from the internet over HTTPS |

Your OAuth service has to support what the clients use: see [what the OAuth
service has to do](configuration#authentication-auth).

An agent's `curl` upload from a cloud sandbox is not signed in: it uses the
one-time URL from `upload-binary-file`, which needs no token.

If a client reports that it cannot sign in, check the server's log: each refusal
is logged with its reason.

### Agent skills and agents

The repository ships two agent skills,
[`read-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/read-binary-file)
and
[`upload-binary-file`](https://github.com/a1ecbr0wn/obsidian-mcp-brain/tree/main/skills/upload-binary-file),
packaged as a plugin and as individual `.skill` files. A plugin can also carry
agents (an `agents/` folder); each one is listed the same way as a skill. The
tools work without them; the skills tell an agent how to use the tools well and,
in `read-binary-file`'s case, what to say when the client can't show a file.

The server tells a connected agent about them. The `initialize` response carries
short `instructions`, and the `get-setup-status` tool returns the list of skills
and agents, the server's version, how to tell which Claude surface the agent is
on, and the install steps for each. The server does not know what a client has
installed: the agent checks its own skill list for the names and compares a
skill's `metadata.version` with the server version, and tells you when a plugin
update may be available. `upload-binary-file`, `read-binary-file` and
`create-binary-file` point to `get-setup-status` in their descriptions.

How you get them depends on where you run Claude:

| Where | How |
| --- | --- |
| Claude Code, including the code mode of the Claude Desktop app | `/plugin marketplace add a1ecbr0wn/obsidian-mcp-brain`, then `/plugin install obsidian-mcp-brain@obsidian-mcp-brain` |
| Cowork, Claude Desktop chat and claude.ai | Download `obsidian-mcp-brain.plugin` from the [latest release](https://github.com/a1ecbr0wn/obsidian-mcp-brain/releases/latest) and upload it at **Customize → Plugins → Add → Upload plugin** |
| One skill on Claude Desktop chat or claude.ai | Upload its `.skill` file from the latest release in **Settings → Capabilities → Skills** |
| Anywhere else | Copy a folder from `skills/` into your agent's skills directory (for Claude Code, `~/.claude/skills/`), or an agent's `<name>.md` file from the release into `~/.claude/agents/` |

A plugin marketplace is a Claude Code feature, so the other surfaces upload the
plugin file. Agents in a plugin run in Claude Code and Cowork; Claude Desktop
chat and claude.ai ignore them. `upload-binary-file` needs a shell on a machine
that can reach the server, so it is of use only where the agent has one. The
`.skill`, `.plugin` and agent files are built from the repository by
`scripts/package-skills.sh`, which needs only `zip`, and are attached to each
release.

If Claude Code refuses the `curl` command that `upload-binary-file` runs, allow
the skill's script with a permission rule in `permissions.allow` of
`~/.claude/settings.json`:
`Bash(sh <path of the skill's upload-binary-file.sh> *)`. A Bash rule matches
the command as the agent wrote it, from its first word (the skill runs its
script with `sh`), so write the path the way it appears in the refusal;
`/permissions` lists the rules. `Bash(curl *)` would allow every `curl`, which
is broader than needed. For a small file, `create-binary-file` needs no `curl`.
