import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_SKILL_PLATFORMS,
  installSkill,
  parseSkillPlatforms,
  skillDestination,
  uninstallSkill,
} from '../lib/skill-install.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('parseSkillPlatforms defaults, all, and rejects unknown names', () => {
  assert.deepEqual(parseSkillPlatforms(null), [...DEFAULT_SKILL_PLATFORMS]);
  assert.ok(parseSkillPlatforms('all').includes('copilot'));
  assert.ok(parseSkillPlatforms('all').includes('claude'));
  assert.deepEqual(parseSkillPlatforms('copilot,claude'), ['copilot', 'claude']);
  assert.throws(() => parseSkillPlatforms('not-a-host'), { code: 'UNKNOWN_SKILL_PLATFORM' });
});

test('install-skill copies SKILL.md and references into isolated agent dirs', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'whatseal-skill-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'whatseal-skill-project-'));
  try {
    const installed = await installSkill({
      projectRoot: PROJECT_ROOT,
      platforms: ['copilot', 'claude'],
      homeDir,
      version: 'test',
    });
    assert.equal(installed.installed.length, 2);
    const dest = skillDestination({ platform: 'copilot', homeDir });
    const body = await readFile(dest, 'utf8');
    assert.match(body, /^---\nname: whatseal\n/m);
    assert.match(body, /whatsapp_wait_ready/);
    const tools = await readFile(path.join(path.dirname(dest), 'references', 'tools.md'), 'utf8');
    assert.match(tools, /whatsapp_unread_digest/);
    const stamp = await readFile(path.join(path.dirname(dest), '.whatseal_version'), 'utf8');
    assert.equal(stamp.trim(), 'test');

    const project = await installSkill({
      projectRoot: PROJECT_ROOT,
      platforms: ['codex'],
      project: true,
      projectDir,
      version: 'test',
    });
    assert.equal(project.installed[0].path, path.join(projectDir, '.codex', 'skills', 'whatseal', 'SKILL.md'));
    await readFile(project.installed[0].path);

    const removed = await uninstallSkill({
      platforms: ['copilot', 'claude'],
      homeDir,
    });
    assert.equal(removed.removed.length, 2);
    await assert.rejects(() => readFile(dest));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});
