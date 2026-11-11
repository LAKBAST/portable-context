import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildContext,
  configDir,
  defaultDevice,
  defaultTeamDir,
  detectProject,
  findTeam,
  git,
  hookDeadline,
  loadConfig,
  refresh,
  resolveProjectTeam,
  saveConfig,
  sessionPath,
  setupContextRepo,
  shareProject,
  slug,
  stagedFindings,
  sync,
  TEAM_TEMPLATE_DIR,
  teamList,
} from './context.js';
import { install, removeSkill, status, uninstall } from './integrations.js';

const DEFAULT_SKILL = 'save-context';

const USAGE = `Usage: pctx <command> [options]

Commands:
  setup <git-url> [--dir <path>] [--device <name>] [--author <name>] [--skill-name <name>]
                 Clone or seed the context repo and install the integrations
  team add <name> <git-url> [--dir <path>] [--author <name>]
                 Clone or seed a team repo shared with other people
  team share <name> [--project <name>] [--cwd <path>]
                 Share a project with a team (creates its notes in the team repo)
  team remove <name>
                 Stop loading a team (the clone is left in place)
  team list      List the teams on this device
  install        Install the hook and skill for Claude Code, Codex and Antigravity
  uninstall      Remove the hook and skill (never touches the context repo)
  doctor         Show device, context repo and integration state
  hook [--format antigravity]
                 SessionStart hook: pull and print the context
  session-path [--project <name>] [--cwd <path>] [--private]
                 Print the path for a new session summary (in the team repo for a
                 shared project; --private always uses the personal repo)
  sync [-m <message>]
                 Scan for secrets, commit, pull and push (the context repo and every team)
  scan           Scan pending changes for secrets without committing`;

const OPTIONS = {
  dir: { type: 'string' },
  device: { type: 'string' },
  author: { type: 'string' },
  'skill-name': { type: 'string' },
  project: { type: 'string' },
  cwd: { type: 'string' },
  message: { type: 'string', short: 'm' },
  private: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function requireConfig() {
  const config = loadConfig();
  if (!config) throw new Error('Not configured. Run: pctx setup <git-url>');
  return config;
}

function formatFindings(findings) {
  return findings.map(({ file, line, rule }) => `${file}:${line} (${rule})`).join('\n');
}

function printInstalled(names) {
  if (!names.length) {
    console.log('No Claude Code, Codex or Antigravity was found on this device; no hook or skill installed.');
    return;
  }
  console.log(`Installed for: ${names.join(', ')}`);
  if (names.includes('codex')) console.log('Codex: approve the new hook with /hooks in Codex.');
  if (names.includes('antigravity')) console.log('Antigravity: the portable-context plugin loads in new conversations.');
}

function runSetup(positionals, values) {
  const url = positionals[0];
  if (!url) throw new Error('Usage: pctx setup <git-url> [--dir <path>] [--device <name>] [--skill-name <name>]');
  const previous = loadConfig();
  const author = values.author ?? previous?.author;
  const config = {
    ...previous,
    contextDir: resolve(values.dir ?? previous?.contextDir ?? join(configDir(), 'context')),
    device: slug(values.device ?? previous?.device ?? defaultDevice()),
    skillName: slug(values['skill-name'] ?? previous?.skillName ?? DEFAULT_SKILL),
    ...(author ? { author: slug(author) } : {}),
  };
  const { seeded } = setupContextRepo(url, config.contextDir);
  // Saved only after install, so a refused install keeps the previous skill name.
  const installed = install(config);
  saveConfig(config);
  if (previous?.skillName && previous.skillName !== config.skillName) removeSkill(previous.skillName);
  console.log(`Context repo: ${config.contextDir}${seeded ? ' (seeded from the template)' : ''}`);
  console.log(`Device: ${config.device}`);
  printInstalled(installed);
  return 0;
}

function sameDir(a, b) {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function teamAdd([name, url], values) {
  if (!name || !url) throw new Error('Usage: pctx team add <name> <git-url> [--dir <path>] [--author <name>]');
  const config = requireConfig();
  const teamName = slug(name);
  const existing = findTeam(config, teamName);
  const dir = resolve(values.dir ?? existing?.dir ?? defaultTeamDir(teamName));
  if (existing && existing.url !== url) {
    throw new Error(`Team ${teamName} already points at ${existing.url}. Remove it first with: pctx team remove ${teamName}`);
  }
  if (sameDir(dir, config.contextDir)) throw new Error('A team repo cannot use the same folder as your context repo');
  const clash = teamList(config).find((team) => team.name !== teamName && sameDir(team.dir, dir));
  if (clash) throw new Error(`${dir} is already used by team ${clash.name}`);
  const { seeded } = setupContextRepo(url, dir, TEAM_TEMPLATE_DIR);
  const team = { name: teamName, url, dir };
  const teams = [...teamList(config).filter((t) => t.name !== teamName), team];
  const author = values.author ?? config.author;
  saveConfig({ ...config, teams, ...(author ? { author: slug(author) } : {}) });
  console.log(`Team ${teamName}: ${dir}${seeded ? ' (seeded from the team template)' : ''}`);
  console.log(`Author in team sessions: ${slug(author ?? config.device)}`);
  console.log(`Share a project with: pctx team share ${teamName} (run it inside the project's repo)`);
  return 0;
}

function teamShare([name], values) {
  if (!name) throw new Error('Usage: pctx team share <name> [--project <name>] [--cwd <path>]');
  const config = requireConfig();
  const team = findTeam(config, name);
  if (!team) throw new Error(`No team named ${slug(name)}. Add it with: pctx team add <name> <git-url>`);
  const project = values.project ? slug(values.project) : detectProject(resolve(values.cwd ?? process.cwd()));
  if (!project) throw new Error('Could not detect the project; pass --project <name>');
  const { file, created } = shareProject(config, team, project);
  console.log(`${created ? 'Shared' : 'Already shared'}: ${project} in team ${team.name} (${file})`);
  if (existsSync(join(config.contextDir, 'projects', `${project}.md`))) {
    console.log(`Your private notes in ${join(config.contextDir, 'projects', `${project}.md`)} stay private; copy to the team file only what the team should read.`);
  }
  if (created) console.log('Run pctx sync to publish it to the team.');
  return 0;
}

function teamRemove([name]) {
  if (!name) throw new Error('Usage: pctx team remove <name>');
  const config = requireConfig();
  const team = findTeam(config, name);
  if (!team) throw new Error(`No team named ${slug(name)}`);
  saveConfig({ ...config, teams: teamList(config).filter((t) => t.name !== team.name) });
  console.log(`Removed team ${team.name}. Its clone is still at ${team.dir}; delete it yourself if you want it gone.`);
  return 0;
}

function teamListCommand() {
  const teams = teamList(requireConfig());
  if (!teams.length) {
    console.log('No teams. Add one with: pctx team add <name> <git-url>');
    return 0;
  }
  for (const team of teams) console.log(`${team.name}: ${redactUrl(team.url)} (${team.dir})`);
  return 0;
}

function runTeam([sub, ...rest], values) {
  switch (sub) {
    case 'add':
      return teamAdd(rest, values);
    case 'share':
      return teamShare(rest, values);
    case 'remove':
      return teamRemove(rest);
    case 'list':
      return teamListCommand();
    default:
      throw new Error('Usage: pctx team <add|share|remove|list>');
  }
}

function runInstall() {
  printInstalled(install(requireConfig()));
  return 0;
}

function runUninstall() {
  const removed = uninstall(loadConfig() ?? { skillName: DEFAULT_SKILL });
  console.log(removed.length ? `Removed from: ${removed.join(', ')}` : 'Nothing to remove.');
  return 0;
}

function redactUrl(url) {
  return url.replace(/\/\/[^/@\s]+@/, '//***@');
}

function runDoctor() {
  const config = requireConfig();
  const remote = git(config.contextDir, ['config', '--get', 'remote.origin.url']);
  console.log(`Device: ${config.device}`);
  console.log(`Context dir: ${config.contextDir}`);
  console.log(`Remote: ${remote.ok ? redactUrl(remote.stdout.trim()) : '(not found)'}`);
  if (config.author) console.log(`Author: ${config.author}`);
  for (const team of teamList(config)) {
    const found = existsSync(join(team.dir, '.git'));
    console.log(`Team ${team.name}: ${redactUrl(team.url)} (${found ? team.dir : `missing clone at ${team.dir}`})`);
  }
  const state = (on) => (on ? 'installed' : 'missing');
  for (const item of status(config)) {
    if (!item.available) {
      console.log(`${item.name}: not found on this device`);
      continue;
    }
    const problem = item.problem ? ` (${item.problem})` : '';
    console.log(`${item.name}: hook ${state(item.hook)}, skill ${state(item.skill)}${problem}`);
  }
  return 0;
}

function readHookInput() {
  try {
    if (process.stdin.isTTY) return {};
    const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
    return input && typeof input === 'object' ? input : {};
  } catch {
    return {};
  }
}

function hookWorkDir(input, antigravity) {
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd;
  // Antigravity sends the open workspaces and runs the hook inside the plugin folder.
  const [workspace] = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  if (typeof workspace === 'string' && workspace) return workspace;
  return antigravity ? homedir() : process.cwd();
}

// Antigravity reads a JSON object from stdout and shows injected steps to the model.
function printHookOutput(text, antigravity) {
  if (!antigravity) {
    if (text) console.log(text);
    return;
  }
  const steps = text ? [{ systemMessage: { systemMessage: text } }] : [];
  console.log(JSON.stringify(steps.length ? { injectSteps: steps } : {}));
}

// A session must start normally even when the context cannot be loaded, so this always returns 0.
function runHook(args) {
  const formatAt = args.indexOf('--format');
  const antigravity = formatAt !== -1 && args[formatAt + 1] === 'antigravity';
  let text = '';
  try {
    const config = loadConfig();
    if (config) {
      const deadline = hookDeadline();
      const workDir = hookWorkDir(readHookInput(), antigravity);
      const personal = refresh(config.contextDir, deadline);
      // The team that owns this project goes first, so a slow team elsewhere cannot starve it.
      const { team: owner } = resolveProjectTeam(config, detectProject(workDir));
      const teams = [...teamList(config)].sort((a, b) => (b.name === owner?.name) - (a.name === owner?.name));
      const teamResults = {};
      for (const team of teams) {
        teamResults[team.name] = existsSync(join(team.dir, '.git'))
          ? refresh(team.dir, deadline)
          : { ok: false, message: `no clone at ${team.dir}; run pctx team add again` };
      }
      text = buildContext(config, workDir, personal, teamResults);
    }
  } catch (err) {
    text = `Portable context unavailable: ${String(err?.message ?? err).split(/\r?\n/)[0]}`;
  }
  printHookOutput(text, antigravity);
  return 0;
}

function runSessionPath(values) {
  const config = requireConfig();
  const project = slug(values.project ?? detectProject(resolve(values.cwd ?? process.cwd())) ?? 'general');
  // --private always points at the personal repo, even for a shared project.
  const { team, conflict } = values.private ? { team: null } : resolveProjectTeam(config, project);
  if (conflict) throw new Error(conflict);
  const file = sessionPath(config, project, new Date(), team);
  mkdirSync(dirname(file), { recursive: true });
  console.log(file);
  return 0;
}

function repos(config) {
  return [
    { label: 'context', dir: config.contextDir },
    ...teamList(config).map((team) => ({ label: `team ${team.name}`, dir: team.dir })),
  ];
}

// Exit code: 0 all fine, 1 a pull or push failed, 2 a secret blocked a commit (the worst wins).
function reportSync(result, prefix) {
  if (result.status === 'synced' || result.status === 'up-to-date') {
    console.log(`${prefix}${result.status}`);
    return 0;
  }
  if (result.status === 'blocked') {
    console.error(`${prefix}blocked: possible secrets found, nothing was committed\n${formatFindings(result.findings)}`);
    return 2;
  }
  console.error(`${prefix}${result.status}: ${result.message}`);
  return 1;
}

function runSync(values) {
  const config = requireConfig();
  const all = repos(config);
  let code = 0;
  for (const { label, dir } of all) {
    const prefix = all.length > 1 ? `${label}: ` : '';
    const message = values.message || (label === 'context' ? undefined : `context: update from ${config.author ?? config.device}`);
    const result = existsSync(join(dir, '.git'))
      ? sync(config, message, dir)
      : { status: 'error', message: `no clone at ${dir}` };
    code = Math.max(code, reportSync(result, prefix));
  }
  return code;
}

function runScan() {
  const all = repos(requireConfig()).filter(({ dir }) => existsSync(join(dir, '.git')));
  let code = 0;
  for (const { label, dir } of all) {
    const prefix = all.length > 1 ? `${label}: ` : '';
    let findings;
    try {
      findings = stagedFindings(dir);
    } finally {
      git(dir, ['reset', '-q']);
    }
    if (!findings.length) {
      console.log(`${prefix}clean`);
      continue;
    }
    console.log(`${prefix}${formatFindings(findings).replaceAll('\n', `\n${prefix}`)}`);
    code = 2;
  }
  return code;
}

function dispatch(command, positionals, values) {
  switch (command) {
    case 'setup':
      return runSetup(positionals, values);
    case 'team':
      return runTeam(positionals, values);
    case 'install':
      return runInstall();
    case 'uninstall':
      return runUninstall();
    case 'doctor':
      return runDoctor();
    case 'session-path':
      return runSessionPath(values);
    case 'sync':
      return runSync(values);
    case 'scan':
      return runScan();
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

export async function main(argv) {
  // Checked before parseArgs: a bad flag must not make the hook exit non-zero.
  if (argv[0] === 'hook') return runHook(argv.slice(1));
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [command, ...rest] = positionals;
    if (!command || values.help) {
      console.log(USAGE);
      return 0;
    }
    return dispatch(command, rest, values);
  } catch (err) {
    console.error(`pctx: ${err.message}`);
    return 1;
  }
}
