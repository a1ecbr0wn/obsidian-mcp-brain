---
layout: docs
title: "Install from npm | obsidian-mcp-brain"
---

## Install from npm

```sh
npm install -g obsidian-mcp-brain
```

This puts an `obsidian-mcp-brain` command on your `PATH`.

Before it will start you need a config file. By default the server reads
`~/.config/obsidian-mcp.json`; set the `CONFIG_PATH` environment variable to use
another location. See [Configuration](../configuration) for the full shape. A
minimal one looks like this:

```json
{
  "mcpBaseUrl": "https://your-hostname:4001",
  "vaults": {
    "knowledge": { "path": "/path/to/your/obsidian/vault" }
  }
}
```

Then start it:

```sh
obsidian-mcp-brain
```

It listens on port 3002 unless `listenPort` says otherwise. To keep it running
across reboots, set it up as a service on [Linux](install-systemd) or
[macOS](install-launchd).
