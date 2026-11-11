import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_ID = 'pctx.js';
const MATCHER = 'startup|resume|clear|compact';
const SKILL_MARKER = '<!-- managed-by: portable-context -->';
const DEFAULT_SKILL = 'save-context';
const PLUGIN_NAME = 'portable-context';
const SKILL_DESCRIPTION =
  'Save this session\'s decisions and state to the user\'s portable context repo and team repos, or share a project with a team. Use only when the user explicitly asks to save the context or session, or to share the project with a team (for example "guarda el contexto", "save context" or "comparte este proyecto con el team").';

function cliPath() {
  return fileURLToPath(new URL('../bin/pctx.js', import.meta.url)).replaceAll('\\', '/');
}

// `node "path"` with forward slashes parses identically in bash, cmd and PowerShell,
// and the agents may run the hook or the skill's commands through any of them.
function cliCommand() {
  return `node "${cliPath()}"`;
}

export function targets() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude');
  const codexHome = process.env.CODEX_HOME || join(os.homedir(), '.codex');
  const antigravityHome = process.env.ANTIGRAVITY_CONFIG_DIR || join(os.homedir(), '.gemini', 'config');
  const pluginDir = join(antigravityHome, 'plugins', PLUGIN_NAME);
  return [
    {
      name: 'claude',
      home: claudeHome,
      hookFile: join(claudeHome, 'settings.json'),
      skillsDir: join(claudeHome, 'skills'),
      hookExtra: {},
      skillFrontmatter: ['disable-model-invocation: true'],
    },
    {
      name: 'codex',
      home: codexHome,
      hookFile: join(codexHome, 'hooks.json'),
      skillsDir: join(os.homedir(), '.agents', 'skills'),
      hookExtra: { additionalContextLimit: 9000 },
      skillFrontmatter: [],
    },
    {
      // Antigravity loads hooks and skills from plugins; pctx owns this whole plugin folder.
      name: 'antigravity',
      plugin: true,
      home: antigravityHome,
      pluginDir,
      hookFile: join(pluginDir, 'hooks.json'),
      skillsDir: join(pluginDir, 'skills'),
      skillFrontmatter: [],
    },
  ];
}

function availableTargets() {
  return targets().filter((target) => existsSync(target.home));
}

function readJson(file) {
  if (!existsSync(file)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${file} is not valid JSON, fix it and retry (nothing was changed): ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON object (nothing was changed)`);
  }
  const hooks = data.hooks;
  if (hooks !== undefined && (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks))) {
    throw new Error(`${file}: "hooks" must be an object (nothing was changed)`);
  }
  if (hooks?.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
    throw new Error(`${file}: "hooks.SessionStart" must be an array (nothing was changed)`);
  }
  return data;
}

function isOurHook(hook) {
  return typeof hook?.command === 'string' && hook.command.includes(HOOK_ID);
}

function withoutOurHook(entries) {
  const kept = [];
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isOurHook)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter((hook) => !isOurHook(hook));
    if (hooks.length) kept.push({ ...entry, hooks });
  }
  return kept;
}

function hasOurHook(data) {
  return (data.hooks?.SessionStart ?? []).some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some(isOurHook));
}

function backupOnce(file) {
  const backup = `${file}.pctx-backup`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
}

function writeJsonAtomic(file, data) {
  // Renaming over a symlink would replace it, and dotfile managers often link these files.
  const target = existsSync(file) ? realpathSync(file) : file;
  const tmp = `${target}.pctx-tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function hookEntry(target) {
  return {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: `${cliCommand()} hook`, timeout: 30, ...target.hookExtra }],
  };
}

// Antigravity hooks.json maps hook names to events, and SessionStart takes handlers directly.
function hasOurPluginHook(data) {
  return Object.values(data).some((spec) => Array.isArray(spec?.SessionStart) && spec.SessionStart.some(isOurHook));
}

function pluginHooks() {
  return {
    [PLUGIN_NAME]: {
      SessionStart: [{ type: 'command', command: `${cliCommand()} hook --format antigravity`, timeout: 30 }],
    },
  };
}

function pluginManifest() {
  return {
    name: PLUGIN_NAME,
    displayName: 'Portable context',
    version: '1.0.0',
    description: 'Loads your pctx context repo at session start and adds the skill that saves it.',
  };
}

function assertPluginOwned(target) {
  const dir = target.pluginDir;
  if (!existsSync(dir) || !readdirSync(dir).length) return;
  if (existsSync(target.hookFile) && hasOurPluginHook(readJson(target.hookFile))) return;
  throw new Error(`${dir} exists and is not managed by pctx; move it away and retry (nothing was changed)`);
}

function installPlugin(target) {
  writeJsonAtomic(join(target.pluginDir, 'plugin.json'), pluginManifest());
  writeJsonAtomic(target.hookFile, pluginHooks());
}

function uninstallPlugin(target) {
  if (!existsSync(target.hookFile) || !hasOurPluginHook(readJson(target.hookFile))) return false;
  rmSync(target.hookFile);
  rmSync(join(target.pluginDir, 'plugin.json'), { force: true });
  return true;
}

// Only empty folders go, so anything the user added to the plugin stays.
function removeIfEmpty(dir) {
  if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
}

function installHook(target) {
  if (target.plugin) return installPlugin(target);
  const data = readJson(target.hookFile);
  const entries = withoutOurHook(data.hooks?.SessionStart ?? []);
  const next = { ...data, hooks: { ...data.hooks, SessionStart: [...entries, hookEntry(target)] } };
  if (JSON.stringify(next) === JSON.stringify(data)) return;
  backupOnce(target.hookFile);
  writeJsonAtomic(target.hookFile, next);
}

function uninstallHook(target) {
  if (target.plugin) return uninstallPlugin(target);
  const data = readJson(target.hookFile);
  if (!hasOurHook(data)) return false;
  const entries = withoutOurHook(data.hooks.SessionStart);
  const hooks = { ...data.hooks, SessionStart: entries };
  if (!entries.length) delete hooks.SessionStart;
  const next = { ...data, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  backupOnce(target.hookFile);
  writeJsonAtomic(target.hookFile, next);
  return true;
}

function skillBody() {
  const cli = cliCommand();
  return `${SKILL_MARKER}

# Save context

Reply to the user in their language. If the user asked to share the project with a team, do "Share a project" first and then "Save"; otherwise do only "Save".

## Share a project

1. Run \`${cli} team list\`. Use the team the user named; if they named none and there is exactly one, use it; otherwise ask which one.
2. Run \`${cli} team share <team> --cwd .\` and note the team notes file it prints.
3. If the user has private notes for this project (\`projects/<project>.md\` in their context repo), split them: write into the team notes file only what the team needs (current state, decisions, pending work, conventions), and keep in the private file only what is not for the team. Old private sessions stay where they are; do not copy them.

## Save

1. Run \`${cli} session-path --cwd .\` (add \`--project <name>\` if the user names another project) and use the printed path. For a project shared with a team, the path is inside that team's repo.
2. Write a short summary at that path: what was decided and why, what is pending, what was tried and failed. Leave out logs, tool output, and anything readable from the code.
3. Update \`projects/<project>.md\` in the same repo as that path so it reflects only the current state, removing what is no longer true. Add a file under \`decisions/\` only for long-term decisions.
4. A team repo is read by everyone in the team: keep it to the shared project. If the session also produced things that are not for the team (opinions about people or clients, the user's own pending tasks, anything they asked to keep private), run \`${cli} session-path --cwd . --private\` and write only those there. When unsure whether something is for the team, put it in the private file. If there is nothing private, write no private file.
5. Never write credentials or personal data about others; refer to people by name.
6. Run \`${cli} sync\`. It syncs the context repo and every team repo; with teams, each line starts with the repo it is about.
   - \`blocked\`: remove the secret at the listed file:line, or ask the user if it is a false positive. Never bypass the check.
   - \`local-only\`: the save is committed on this device but has not reached the remote. Tell the user.
7. Tell the user in one or two lines what went where (for example "saved to team lakbast; 2 private notes in your context repo") and whether it reached the remote.
`;
}

function skillContent(target, name) {
  const frontmatter = [`name: ${name}`, `description: ${SKILL_DESCRIPTION}`, ...target.skillFrontmatter];
  return `---\n${frontmatter.join('\n')}\n---\n\n${skillBody()}`;
}

function skillFile(target, name) {
  return join(target.skillsDir, name, 'SKILL.md');
}

function isManagedSkill(file) {
  return readFileSync(file, 'utf8').includes(SKILL_MARKER);
}

function assertSkillWritable(target, name) {
  const file = skillFile(target, name);
  if (existsSync(file) && !isManagedSkill(file)) {
    throw new Error(`${file} exists and is not managed by pctx; use --skill-name to pick another name (nothing was changed)`);
  }
}

function installSkill(target, name) {
  const file = skillFile(target, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, skillContent(target, name));
}

function uninstallSkill(target, name) {
  const file = skillFile(target, name);
  if (!existsSync(file) || !isManagedSkill(file)) return false;
  rmSync(file);
  // Other files in the folder are the user's, so the folder only goes if it is now empty.
  if (!readdirSync(dirname(file)).length) rmdirSync(dirname(file));
  return true;
}

export function install(config) {
  const name = config?.skillName || DEFAULT_SKILL;
  const available = availableTargets();
  // Validate every target first so a problem in one leaves the others untouched.
  for (const target of available) {
    readJson(target.hookFile);
    if (target.plugin) assertPluginOwned(target);
    assertSkillWritable(target, name);
  }
  for (const target of available) {
    installHook(target);
    installSkill(target, name);
  }
  return available.map((target) => target.name);
}

export function uninstall(config) {
  const name = config?.skillName || DEFAULT_SKILL;
  const all = targets();
  for (const target of all) readJson(target.hookFile);
  const removed = [];
  for (const target of all) {
    const hook = uninstallHook(target);
    const skill = uninstallSkill(target, name);
    if (target.plugin) {
      removeIfEmpty(target.skillsDir);
      removeIfEmpty(target.pluginDir);
    }
    if (hook || skill) removed.push(target.name);
  }
  return removed;
}

export function removeSkill(name) {
  for (const target of targets()) uninstallSkill(target, name);
}

function hookStatus(target) {
  try {
    const data = readJson(target.hookFile);
    return { hook: target.plugin ? hasOurPluginHook(data) : hasOurHook(data) };
  } catch (err) {
    return { hook: false, problem: err.message };
  }
}

function skillStatus(target, name) {
  const file = skillFile(target, name);
  if (!existsSync(file)) return { skill: false };
  return isManagedSkill(file) ? { skill: true } : { skill: false, problem: `${file} is not managed by pctx` };
}

export function status(config) {
  const name = config?.skillName || DEFAULT_SKILL;
  return targets().map((target) => {
    const hook = hookStatus(target);
    const skill = skillStatus(target, name);
    const problem = [hook.problem, skill.problem].filter(Boolean).join('; ');
    return {
      name: target.name,
      available: existsSync(target.home),
      hook: hook.hook,
      skill: skill.skill,
      ...(problem ? { problem } : {}),
    };
  });
}
