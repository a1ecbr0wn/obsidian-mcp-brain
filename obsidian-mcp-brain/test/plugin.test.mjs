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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SKILLS = path.join(ROOT, 'skills');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const skillNames = fs.readdirSync(SKILLS).filter(n => fs.statSync(path.join(SKILLS, n)).isDirectory());

/** Reads the top-level `key: value` pairs of a SKILL.md frontmatter block. */
function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file} has no frontmatter`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

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
    assert.ok(entries.every(e => e.startsWith('.claude-plugin/') || e.startsWith('skills/')));
    assert.ok(!entries.some(e => /(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(e)));
  });
});
