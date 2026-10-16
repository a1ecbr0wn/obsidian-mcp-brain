/**
 * Unit tests for lib/companions.mjs: the list of companion skills and agents and the text
 * built from it. That the list matches the repository's skills/ and agents/ folders is
 * checked in plugin.test.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIONS, SETUP_INSTRUCTIONS, RELEASES_URL, REPOSITORY, setupStatusText } from '../lib/companions.mjs';
import { TOOL_ROLES, toolAllowed } from '../lib/auth.mjs';

describe('COMPANIONS', () => {
  it('is frozen, and each entry has a type, a name, a purpose and the tools it helps', () => {
    assert.ok(Object.isFrozen(COMPANIONS));
    assert.ok(COMPANIONS.length > 0);
    for (const c of COMPANIONS) {
      assert.ok(Object.isFrozen(c), c.name);
      assert.ok(['skill', 'agent'].includes(c.type), c.name);
      assert.match(c.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.ok(c.purpose.length > 0 && !c.purpose.includes('\n'), c.name);
      assert.ok(c.tools.length > 0 && Object.isFrozen(c.tools), c.name);
    }
  });

  it('has no duplicate names within a type', () => {
    const keys = COMPANIONS.map(c => `${c.type}:${c.name}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('SETUP_INSTRUCTIONS', () => {
  it('is under 1,000 characters and names get-setup-status and the version comparison', () => {
    assert.ok(SETUP_INSTRUCTIONS.length < 1000, `${SETUP_INSTRUCTIONS.length} characters`);
    assert.ok(SETUP_INSTRUCTIONS.includes('get-setup-status'));
    assert.ok(SETUP_INSTRUCTIONS.includes('metadata.version'));
  });

  it('names the tools that need the skills', () => {
    assert.ok(SETUP_INSTRUCTIONS.includes('read-binary-file'));
    assert.ok(SETUP_INSTRUCTIONS.includes('upload-binary-file'));
  });
});

describe('setupStatusText', () => {
  const text = setupStatusText('9.8.7');

  it('states the server version', () => {
    assert.ok(text.includes('9.8.7'));
  });

  it('lists every companion with its type, purpose and tools', () => {
    for (const c of COMPANIONS) {
      assert.ok(text.includes(`${c.type} ${c.name}: ${c.purpose}`), c.name);
      for (const t of c.tools) assert.ok(text.includes(t), t);
    }
  });

  it('gives the install steps for every surface and how to tell them apart', () => {
    assert.ok(text.includes(`/plugin marketplace add ${REPOSITORY}`));
    assert.ok(text.includes('/plugin install'));
    assert.ok(text.includes(RELEASES_URL));
    assert.ok(text.includes('Customize > Plugins > Add > Upload plugin'));
    assert.ok(text.includes('Settings > Capabilities > Skills'));
    assert.ok(text.includes('~/.claude/agents/'));
    for (const marker of ['~/.claude/skills/', '/mnt/skills/', '/home/claude', '/root/.claude/skills/synced/']) {
      assert.ok(text.includes(marker), marker);
    }
  });

  it('says what to do without the skills, including the permission rule', () => {
    assert.ok(text.includes('permissions.allow'));
    assert.ok(text.includes('create-binary-file'));
  });

  it('names no deployment address', () => {
    assert.ok(!/localhost|127\.0\.0\.1|ts\.net/.test(text));
    assert.ok(!/localhost|127\.0\.0\.1|ts\.net/.test(SETUP_INSTRUCTIONS));
  });
});

describe('get-setup-status role', () => {
  it('is a read tool, so a read-only user may call it', () => {
    assert.equal(TOOL_ROLES['get-setup-status'], 'read');
    assert.equal(toolAllowed('readonly', 'get-setup-status'), true);
    assert.equal(toolAllowed('full', 'get-setup-status'), true);
  });
});
