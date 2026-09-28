---
layout: docs
title: "Run as a systemd service | obsidian-mcp-brain"
---

## Run as a systemd service

First create your config file, described in [Configuration](../configuration). By
default the server reads `~/.config/obsidian-mcp.json`, so no extra environment
variable is needed unless you keep the config elsewhere.

Create `~/.config/systemd/user/obsidian-mcp.service`:

```ini
[Unit]
Description=Obsidian MCP Server
After=network.target

[Service]
ExecStart=/usr/bin/env obsidian-mcp-brain
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`ExecStart` finds `obsidian-mcp-brain` through the service's `PATH`, and the
command in turn needs `node` on that same `PATH`. A user service does not always
inherit the directories npm and Node were installed into, which is common with
nvm and similar tools. If the service fails to start, use the full path shown by
`command -v obsidian-mcp-brain` in `ExecStart`, and add the directory containing
`node` with an `Environment=PATH=...` line.

If your config file lives somewhere other than `~/.config/obsidian-mcp.json`, add
this under `[Service]`:

```ini
Environment=CONFIG_PATH=/path/to/your/config.json
```

Then enable and start it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now obsidian-mcp.service
```

After changing the config file, restart the service:

```sh
systemctl --user restart obsidian-mcp
```
