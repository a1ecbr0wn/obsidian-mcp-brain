---
layout: docs
title: "Run as a launchd agent | obsidian-mcp-brain"
---

## Run as a launchd agent (macOS)

Create `~/Library/LaunchAgents/com.obsidian-mcp-brain.plist`. Adjust the path to
`obsidian-mcp-brain` if `command -v obsidian-mcp-brain` shows somewhere other than
`/usr/local/bin`, for example `/opt/homebrew/bin` with Homebrew on Apple Silicon.
launchd starts agents with only a minimal `PATH`, and the command needs `node` on
it, so add the directory containing `node` to the `EnvironmentVariables` entry
below as a `PATH` key:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.obsidian-mcp-brain</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/obsidian-mcp-brain</string>
  </array>

  <!-- Only needed if your config file isn't at the default
  ~/.config/obsidian-mcp.json -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONFIG_PATH</key>
    <string>/path/to/your/obsidian-mcp.json</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/obsidian-mcp-brain.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/obsidian-mcp-brain.log</string>
</dict>
</plist>
```

Load it:

```sh
launchctl load ~/Library/LaunchAgents/com.obsidian-mcp-brain.plist
```

To restart after a config change:

```sh
launchctl unload ~/Library/LaunchAgents/com.obsidian-mcp-brain.plist
launchctl load   ~/Library/LaunchAgents/com.obsidian-mcp-brain.plist
```
