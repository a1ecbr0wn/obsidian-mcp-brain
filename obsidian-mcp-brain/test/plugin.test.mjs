/**
 * Checks the agent-skill packaging in the repository root: the plugin and marketplace
 * manifests, each skill's frontmatter, and scripts/package-skills.sh. The frontmatter rules
 * (a folder named after the skill, a closed set of keys, a description of at most 1024
 * characters without angle brackets) are the ones the user's own skill packager applies
 * before upload, so a broken skill is caught here and not when it is uploaded.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANIONS } from '../lib/companions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SKILLS = path.join(ROOT, 'skills');
const AGENTS = path.join(ROOT, 'agents');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const skillNames = fs.readdirSync(SKILLS).filter(n => fs.statSync(path.join(SKILLS, n)).isDirectory());
// agents/ is optional: no agent ships yet
const agentNames = fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS).filter(n => n.endsWith('.md')).map(n => n.slice(0, -3)) : [];

/**
 * Parses the top-level `key: value` pairs of a file's frontmatter block (SKILL.md or an agent
 * file). The two-space-indented `version:` line under `metadata:` is attached as a
 * non-enumerable `version` property, so the closed-key check sees only top-level keys.
 * Fails the calling test if the file has no frontmatter block.
 * @param {string} file - Absolute path to the Markdown file.
 * @returns {Record<string, string> & {version?: string}} Raw values, without quotes stripped.
 */
function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file} has no frontmatter`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
    const ver = line.match(/^ {2}version:\s*"?([^"\s]+)"?\s*$/);
    // not enumerable, so the closed-key check below sees only the top-level keys
    if (ver) Object.defineProperty(out, 'version', { value: ver[1] });
  }
  return out;
}

/**
 * The first sentence of a description: up to the first full stop followed by whitespace or the
 * end of the text. The search stays on the first line, and a text with no such full stop on
 * that line is returned whole. An abbreviation such as "e.g. " ends the sentence early.
 * @param {string} text - A skill or agent description.
 * @returns {string}
 */
const firstSentence = (text) => text.match(/^.*?\.(?=\s|$)/)?.[0] ?? text;

describe('plugin manifests', () => {
  const plugin = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'));
  const market = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json'));

  it('plugin.json has a kebab-case name, a semver version and a description', () => {
    assert.match(plugin.name, KEBAB);
    assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
    assert.ok(plugin.description);
  });

  it('plugin.json version matches both package versions, which the tag workflow bumps together', () => {
    for (const p of [['obsidian-mcp-brain', 'package.json'], ['package.json']]) {
      assert.equal(plugin.version, readJson(path.join(ROOT, ...p)).version, p.join('/'));
    }
  });

  it('marketplace.json lists the plugin from the repository root', () => {
    assert.match(market.name, KEBAB);
    assert.ok(market.owner?.name);
    const entry = market.plugins.find(p => p.name === plugin.name);
    assert.ok(entry, 'the marketplace must list the plugin');
    assert.equal(entry.source, './');
  });
});

describe('skills', () => {
  it('there is at least one skill', () => {
    assert.ok(skillNames.length > 0);
  });

  for (const name of skillNames) {
    it(`${name}: SKILL.md is valid`, () => {
      const fm = frontmatter(path.join(SKILLS, name, 'SKILL.md'));
      assert.equal(fm.name, name, 'frontmatter name must equal the folder name');
      assert.match(fm.name, KEBAB);
      assert.ok(fm.name.length <= 64);
      assert.ok(fm.description, 'description is required');
      assert.ok(fm.description.length <= 1024, 'description is at most 1024 characters');
      assert.ok(!/[<>]/.test(fm.description), 'description must not contain angle brackets');
      for (const key of Object.keys(fm)) assert.ok(FRONTMATTER_KEYS.has(key), `unexpected frontmatter key: ${key}`);
    });
  }
});

describe('skill versions', () => {
  const plugin = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'));

  for (const name of skillNames) {
    it(`${name}: metadata.version equals the plugin version, which the tag workflow bumps together`, () => {
      assert.equal(frontmatter(path.join(SKILLS, name, 'SKILL.md')).version, plugin.version);
    });
  }
});

describe('agents', () => {
  for (const name of agentNames) {
    it(`${name}: the agent file has frontmatter with a name equal to the file name and a description`, () => {
      const fm = frontmatter(path.join(AGENTS, `${name}.md`));
      assert.equal(fm.name, name);
      assert.match(fm.name, KEBAB);
      assert.ok(fm.description, 'description is required');
    });
  }
});

describe('lib/companions.mjs matches the repository', () => {
  it('lists exactly the skills and agents in skills/ and agents/', () => {
    const fromFolders = [...skillNames.map(n => `skill:${n}`), ...agentNames.map(n => `agent:${n}`)].sort();
    assert.deepEqual(COMPANIONS.map(c => `${c.type}:${c.name}`).sort(), fromFolders);
  });

  for (const c of COMPANIONS) {
    it(`${c.type} ${c.name}: the purpose is the first sentence of its description`, () => {
      const file = c.type === 'skill' ? path.join(SKILLS, c.name, 'SKILL.md') : path.join(AGENTS, `${c.name}.md`);
      assert.equal(c.purpose, firstSentence(frontmatter(file).description));
    });
  }
});

describe('scripts/package-skills.sh', { skip: spawnSync('sh', ['-c', 'command -v zip && command -v unzip']).status !== 0 && 'zip or unzip is not installed' }, () => {
  let out;
  let run;
  before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-skills-'));
    run = spawnSync('sh', [path.join(ROOT, 'scripts', 'package-skills.sh'), out], { encoding: 'utf8' });
  });
  after(() => { fs.rmSync(out, { recursive: true, force: true }); });

  const list = (file) => {
    const r = spawnSync('unzip', ['-Z1', path.join(out, file)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const entries = r.stdout.split('\n').filter(Boolean);
    assert.ok(entries.length > 0, `${file} is empty`);
    return entries;
  };

  it('writes one .skill per skill and a .plugin', () => {
    assert.equal(run.status, 0, run.stderr);
    for (const name of skillNames) assert.ok(fs.existsSync(path.join(out, `${name}.skill`)), `${name}.skill`);
    assert.ok(fs.existsSync(path.join(out, 'obsidian-mcp-brain.plugin')));
  });

  it('each .skill has its folder as the only top-level entry, with SKILL.md in it', () => {
    for (const name of skillNames) {
      const entries = list(`${name}.skill`);
      assert.ok(entries.includes(`${name}/SKILL.md`), `${name}/SKILL.md`);
      assert.ok(entries.every(e => e.startsWith(`${name}/`)), 'every entry is under the skill folder');
    }
  });

  it('every file of every skill is in its .skill and in the .plugin', () => {
    const plugin = list('obsidian-mcp-brain.plugin');
    for (const name of skillNames) {
      const skill = list(`${name}.skill`);
      const files = fs.readdirSync(path.join(SKILLS, name), { recursive: true, withFileTypes: true })
        .filter(d => d.isFile())
        .map(d => path.relative(SKILLS, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/'));
      for (const f of files) {
        assert.ok(skill.includes(f), `${f} in ${name}.skill`);
        assert.ok(plugin.includes(`skills/${f}`), `${f} in the .plugin`);
      }
    }
  });

  it('the .plugin holds the manifest and not the marketplace file, the server or git data', () => {
    const entries = list('obsidian-mcp-brain.plugin');
    assert.ok(entries.includes('.claude-plugin/plugin.json'));
    assert.ok(!entries.includes('.claude-plugin/marketplace.json'));
    assert.ok(entries.every(e => e.startsWith('.claude-plugin/') || e.startsWith('skills/') || e.startsWith('agents/')));
    assert.ok(!entries.some(e => /(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(e)));
  });
});

describe('scripts/package-skills.sh with an agents/ folder', { skip: spawnSync('sh', ['-c', 'command -v zip && command -v unzip']).status !== 0 && 'zip or unzip is not installed' }, () => {
  let work;
  let out;
  let run;
  before(() => {
    // a copy of the packaging inputs with one agent added, so the real repository is untouched
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-agents-'));
    out = path.join(work, 'dist');
    fs.cpSync(path.join(ROOT, 'skills'), path.join(work, 'skills'), { recursive: true });
    fs.cpSync(path.join(ROOT, '.claude-plugin'), path.join(work, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(work, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'package-skills.sh'), path.join(work, 'scripts', 'package-skills.sh'));
    fs.mkdirSync(path.join(work, 'agents'));
    fs.writeFileSync(path.join(work, 'agents', 'fixture-agent.md'), '---\nname: fixture-agent\ndescription: A fixture.\n---\nBody.\n');
    run = spawnSync('sh', [path.join(work, 'scripts', 'package-skills.sh'), out], { encoding: 'utf8' });
  });
  after(() => { fs.rmSync(work, { recursive: true, force: true }); });

  it('writes <name>.md for the agent and puts it in the .plugin', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(path.join(out, 'fixture-agent.md'), 'utf8'), fs.readFileSync(path.join(work, 'agents', 'fixture-agent.md'), 'utf8'));
    const r = spawnSync('unzip', ['-Z1', path.join(out, 'obsidian-mcp-brain.plugin')], { encoding: 'utf8' });
    assert.ok(r.stdout.split('\n').includes('agents/fixture-agent.md'));
  });

  it('still writes every .skill', () => {
    for (const name of skillNames) assert.ok(fs.existsSync(path.join(out, `${name}.skill`)), name);
  });
});

describe('scripts/package-skills.sh without an agents/ folder', { skip: spawnSync('sh', ['-c', 'command -v zip && command -v unzip']).status !== 0 && 'zip or unzip is not installed' }, () => {
  let work;
  let out;
  let run;
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-noagents-'));
    out = path.join(work, 'dist');
    fs.cpSync(path.join(ROOT, 'skills'), path.join(work, 'skills'), { recursive: true });
    fs.cpSync(path.join(ROOT, '.claude-plugin'), path.join(work, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(work, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'package-skills.sh'), path.join(work, 'scripts', 'package-skills.sh'));
    run = spawnSync('sh', [path.join(work, 'scripts', 'package-skills.sh'), out], { encoding: 'utf8' });
  });
  after(() => { fs.rmSync(work, { recursive: true, force: true }); });

  it('packages the skills and the plugin, and writes no agent file', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(out, 'obsidian-mcp-brain.plugin')));
    assert.deepEqual(fs.readdirSync(out).filter(n => n.endsWith('.md')), []);
    const r = spawnSync('unzip', ['-Z1', path.join(out, 'obsidian-mcp-brain.plugin')], { encoding: 'utf8' });
    assert.ok(!r.stdout.split('\n').some(e => e.startsWith('agents/')));
  });
});
