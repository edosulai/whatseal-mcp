import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SKILL_NAME = 'whatseal';

export const SKILL_PLATFORMS = Object.freeze({
  copilot: { home: ['.copilot', 'skills'] },
  claude: { home: ['.claude', 'skills'] },
  codex: { home: ['.codex', 'skills'] },
  agents: { home: ['.agents', 'skills'] },
  cursor: { home: ['.cursor', 'skills'] },
  gemini: { home: ['.gemini', 'skills'] },
  opencode: { home: ['.config', 'opencode', 'skills'] },
  kilo: { home: ['.config', 'kilo', 'skills'] },
  aider: { home: ['.aider', 'skills'] },
  claw: { home: ['.openclaw', 'skills'] },
  droid: { home: ['.factory', 'skills'] },
  trae: { home: ['.trae', 'skills'] },
  'trae-cn': { home: ['.trae-cn', 'skills'] },
  hermes: { home: ['.hermes', 'skills'] },
  kiro: { home: ['.kiro', 'skills'] },
  pi: { home: ['.pi', 'agent', 'skills'] },
  codebuddy: { home: ['.codebuddy', 'skills'] },
  antigravity: { home: ['.gemini', 'config', 'skills'] },
  windows: { home: ['.claude', 'skills'] },
  kimi: { home: ['.kimi', 'skills'] },
  amp: { home: ['.config', 'agents', 'skills'] },
  devin: { home: ['.config', 'devin', 'skills'] },
});

export const DEFAULT_SKILL_PLATFORMS = Object.freeze([
  'copilot',
  'claude',
  'codex',
  'agents',
  'hermes',
]);

const PROJECT_SKILL_ROOTS = Object.freeze({
  copilot: ['.copilot', 'skills'],
  claude: ['.claude', 'skills'],
  codex: ['.codex', 'skills'],
  agents: ['.agents', 'skills'],
  cursor: ['.cursor', 'skills'],
  gemini: ['.gemini', 'skills'],
  opencode: ['.opencode', 'skills'],
  kilo: ['.kilo', 'skills'],
  aider: ['.aider', 'skills'],
  claw: ['.openclaw', 'skills'],
  droid: ['.factory', 'skills'],
  trae: ['.trae', 'skills'],
  'trae-cn': ['.trae-cn', 'skills'],
  hermes: ['.hermes', 'skills'],
  kiro: ['.kiro', 'skills'],
  pi: ['.pi', 'agent', 'skills'],
  codebuddy: ['.codebuddy', 'skills'],
  antigravity: ['.agents', 'skills'],
  windows: ['.claude', 'skills'],
  kimi: ['.kimi', 'skills'],
  amp: ['.agents', 'skills'],
  devin: ['.devin', 'skills'],
});

export function packagedSkillDir(projectRoot, skillName = DEFAULT_SKILL_NAME) {
  return path.join(projectRoot, 'skills', skillName);
}

export function skillDestination({
  platform,
  project = false,
  projectDir = process.cwd(),
  homeDir = os.homedir(),
  skillName = DEFAULT_SKILL_NAME,
} = {}) {
  const parts = project ? PROJECT_SKILL_ROOTS[platform] : SKILL_PLATFORMS[platform]?.home;
  if (!parts) {
    const error = new Error(`Unknown skill platform: ${platform}`);
    error.code = 'UNKNOWN_SKILL_PLATFORM';
    throw error;
  }
  const root = project ? projectDir : homeDir;
  return path.join(root, ...parts, skillName, 'SKILL.md');
}

export function parseSkillPlatforms(raw, { defaultPlatforms = DEFAULT_SKILL_PLATFORMS } = {}) {
  if (raw == null || raw === '') return [...defaultPlatforms];
  const requested = String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.includes('all')) return Object.keys(SKILL_PLATFORMS);
  const unknown = requested.filter((name) => !SKILL_PLATFORMS[name]);
  if (unknown.length > 0) {
    const error = new Error(`Unknown skill platform: ${unknown.join(', ')}`);
    error.code = 'UNKNOWN_SKILL_PLATFORM';
    throw error;
  }
  return [...new Set(requested)];
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function copySkillTree(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  await copyFile(path.join(srcDir, 'SKILL.md'), path.join(destDir, 'SKILL.md'));
  const refsSrc = path.join(srcDir, 'references');
  const refsDest = path.join(destDir, 'references');
  await rm(refsDest, { recursive: true, force: true });
  let entries = [];
  try {
    entries = await readdir(refsSrc, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await mkdir(refsDest, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await copyFile(path.join(refsSrc, entry.name), path.join(refsDest, entry.name));
  }
}

async function pruneEmptyParents(startDir, stopDir) {
  let current = startDir;
  for (let i = 0; i < 4; i += 1) {
    if (!current || current === stopDir) break;
    try {
      await rm(current, { recursive: false });
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

export async function installSkill({
  projectRoot,
  platforms = DEFAULT_SKILL_PLATFORMS,
  project = false,
  projectDir = process.cwd(),
  homeDir = os.homedir(),
  skillName = DEFAULT_SKILL_NAME,
  version = 'unknown',
} = {}) {
  const srcDir = packagedSkillDir(projectRoot, skillName);
  const skillSrc = path.join(srcDir, 'SKILL.md');
  await readFile(skillSrc);
  const installed = [];
  for (const platform of platforms) {
    const dest = skillDestination({ platform, project, projectDir, homeDir, skillName });
    const destDir = path.dirname(dest);
    await copySkillTree(srcDir, destDir);
    await writeFile(path.join(destDir, '.whatseal_version'), `${version}\n`, 'utf8');
    installed.push({ platform, path: dest });
  }
  return { skillName, version, project, installed };
}

export function hermesMcpAttachCommand(projectRoot) {
  const localCommand = path.join(projectRoot, 'mcp-wrapper.sh');
  return {
    host: 'hermes',
    skillPath: `~/.hermes/skills/${DEFAULT_SKILL_NAME}/SKILL.md`,
    add: "printf 'Y\\n' | hermes mcp add whatseal --command npx --args -y --args whatseal --args mcp",
    local: {
      command: localCommand,
      add: `printf 'Y\\n' | hermes mcp add whatseal --command ${JSON.stringify(localCommand)}`,
    },
    config: {
      mcp_servers: {
        whatseal: {
          command: 'npx',
          args: ['-y', 'whatseal', 'mcp'],
        },
      },
    },
    note: 'Restart Hermes after adding. Tools register as mcp_whatseal_whatsapp_*. From a git checkout, local.command still points at mcp-wrapper.sh.',
  };
}

export async function uninstallSkill({
  platforms = DEFAULT_SKILL_PLATFORMS,
  project = false,
  projectDir = process.cwd(),
  homeDir = os.homedir(),
  skillName = DEFAULT_SKILL_NAME,
} = {}) {
  const removed = [];
  for (const platform of platforms) {
    const dest = skillDestination({ platform, project, projectDir, homeDir, skillName });
    const destDir = path.dirname(dest);
    if (!await pathExists(destDir)) continue;
    await rm(destDir, { recursive: true, force: true });
    await pruneEmptyParents(path.dirname(destDir), project ? projectDir : homeDir);
    removed.push({ platform, path: dest });
  }
  return { skillName, project, removed };
}

export function defaultProjectRootFrom(moduleUrl = import.meta.url) {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}
