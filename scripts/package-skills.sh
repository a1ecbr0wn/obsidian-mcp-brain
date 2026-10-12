#!/bin/sh
# Packages the agent skills for the places a plugin marketplace does not reach.
#
#   dist/<skill>.skill              one per folder in skills/, for upload in Claude Desktop chat
#                                   or claude.ai (Settings, Capabilities, Skills)
#   dist/obsidian-mcp-brain.plugin  the whole plugin, for Cowork
#
# Claude Code installs the plugin straight from the repository, so it needs none of this.
# Needs only `zip`. Usage: scripts/package-skills.sh [output directory]
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/dist"}

command -v zip >/dev/null 2>&1 || { echo "package-skills: zip is required" >&2; exit 1; }
mkdir -p "$out"
out=$(cd "$out" && pwd)

count=0
for dir in "$root"/skills/*/; do
  name=$(basename "$dir")
  [ -f "$dir/SKILL.md" ] || { echo "package-skills: skills/$name has no SKILL.md" >&2; exit 1; }
  rm -f "$out/$name.skill"
  # The folder is the zip's single top-level entry, and its name must match the skill's `name`.
  (cd "$root/skills" && zip -qry -X "$out/$name.skill" "$name" -x '*.DS_Store')
  echo "$out/$name.skill"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "package-skills: no skills found" >&2; exit 1; }

rm -f "$out/obsidian-mcp-brain.plugin"
(cd "$root" && zip -qry -X "$out/obsidian-mcp-brain.plugin" .claude-plugin/plugin.json skills -x '*.DS_Store')
echo "$out/obsidian-mcp-brain.plugin"
