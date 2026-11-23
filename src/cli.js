import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildContext,
  configDir,
  defaultDevice,
  defaultTeamDir,
  findTeam,
  git,
  hasScopeRules,
  hookDeadline,
  hookRefresh,
  loadConfig,
  parseRemote,
  redactUrl,
  resolveHookRefreshSeconds,
  resolveScope,
  saveConfig,
  sessionPath,
  setupContextRepo,
  shareProject,
  slug,
  stagedFindings,
  sync,
  TEAM_TEMPLATE_DIR,
  teamList,
  validateConfig,
  validatePrivateDestination,
} from './context.js';
import { install, removeSkill, status, uninstall } from './integrations.js';
import { isPersonalDataRule } from './secrets.js';

const DEFAULT_SKILL = 'save-context';

const USAGE = `Usage: pctx <command> [options]

Commands:
  setup <git-url> [--dir <path>] [--device <name>] [--author <name>] [--skill-name <name>] [--project-identity <legacy|remote>]
                 Clone or seed the context repo and install the integrations
  team add <name> <git-url> [--dir <path>] [--author <name>] [--isolated] [--remote <url>]... [--namespace <prefix>]... [--private-dir <path>] [--private-url <url>]
                 Clone or seed a team repo shared with other people
  team share <name> [--project <name>] [--cwd <path>]
                 Share a project with a team (creates its notes in the team repo)
  team remove <name>
                 Stop loading a team (the clone is left in place)
  team list      List the teams on this device
  install        Install the hook and skill for Claude Code, Codex and Antigravity
                 (plus a Codex rule that lets pctx sync run without approval)
  uninstall      Remove the hook, skill and rule (never touches the context repo)
  doctor         Show device, context repo and integration state
  hook [--format antigravity]
                 SessionStart hook: pull and print the context
  session-path [--project <name>] [--cwd <path>] [--team <name>] [--private]
                 Print the path for a new session summary (in the team repo for a
                 shared project; --private uses the personal repo or the team's privateDir)
  sync [-m <message>] [--cwd <path>] [--team <name>]
                 Scan for secrets, commit, pull and push the active scope
  scan [--cwd <path>] [--team <name>]
                 Scan pending changes in the active scope for secrets without committing`;

const OPTIONS = {
  dir: { type: 'string' },
  device: { type: 'string' },
  author: { type: 'string' },
  'skill-name': { type: 'string' },
  'project-identity': { type: 'string' },
  isolated: { type: 'boolean' },
  remote: { type: 'string', multiple: true },
  namespace: { type: 'string', multiple: true },
  'private-dir': { type: 'string' },
  'private-url': { type: 'string' },
  project: { type: 'string' },
  cwd: { type: 'string' },
  team: { type: 'string' },
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
  const projectIdentity = values['project-identity'] ?? previous?.projectIdentity;
  if (projectIdentity !== undefined && projectIdentity !== 'legacy' && projectIdentity !== 'remote') {
    throw new Error(`Invalid --project-identity "${projectIdentity}" (expected "legacy" or "remote")`);
  }
  const author = values.author ?? previous?.author;
  const config = {
    ...previous,
    contextDir: resolve(values.dir ?? previous?.contextDir ?? join(configDir(), 'context')),
    device: slug(values.device ?? previous?.device ?? defaultDevice()),
    skillName: slug(values['skill-name'] ?? previous?.skillName ?? DEFAULT_SKILL),
    ...(projectIdentity ? { projectIdentity } : {}),
    ...(author ? { author: slug(author) } : {}),
  };
  validateConfig(config, git);
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

function normalizeRemoteList(values) {
  return (values ?? []).map((item) => {
    const parsed = parseRemote(item, { allowShorthand: true });
    if (!parsed) throw new Error(`Invalid remote "${redactUrl(item)}"`);
    return parsed.canonical;
  });
}

function teamAdd([name, url], values) {
  if (!name || !url) {
    throw new Error(
      'Usage: pctx team add <name> <git-url> [--dir <path>] [--author <name>] [--isolated] [--remote <url>]... [--namespace <prefix>]... [--private-dir <path>] [--private-url <url>]',
    );
  }
  const config = requireConfig();
  const teamName = slug(name);
  const existing = findTeam(config, teamName);
  const dir = resolve(values.dir ?? existing?.dir ?? defaultTeamDir(teamName));
  if (existing && existing.url !== url) {
    throw new Error(
      `Team ${teamName} already points at ${redactUrl(existing.url)}. Remove it first with: pctx team remove ${teamName}`,
    );
  }
  const isolated = values.isolated ?? existing?.isolated ?? false;
  const remotes = values.remote ? normalizeRemoteList(values.remote) : existing?.remotes;
  const namespaces = values.namespace ? values.namespace : existing?.namespaces;
  const privateUrl = values['private-url'] ?? existing?.privateUrl;
  const privateDir =
    values['private-dir'] || values['private-url']
      ? resolve(values['private-dir'] ?? existing?.privateDir ?? join(configDir(), 'teams', `${teamName}-private`))
      : existing?.privateDir;

  if (!isolated && (privateDir || privateUrl)) {
    throw new Error('--private-dir and --private-url require --isolated');
  }

  const team = {
    ...(existing ?? {}),
    name: teamName,
    url,
    dir,
    ...(isolated ? { isolated: true } : {}),
    ...(remotes?.length ? { remotes } : {}),
    ...(namespaces?.length ? { namespaces } : {}),
    ...(privateDir ? { privateDir } : {}),
    ...(privateUrl ? { privateUrl } : {}),
  };
  const teams = [...teamList(config).filter((t) => t.name !== teamName), team];
  const author = values.author ?? config.author;
  const nextConfig = { ...config, teams, ...(author ? { author: slug(author) } : {}) };
  validateConfig(nextConfig, git);

  if (privateDir && !privateUrl) {
    validatePrivateDestination(nextConfig, team, git);
  }
  const { seeded } = setupContextRepo(url, dir, TEAM_TEMPLATE_DIR);
  if (isolated) validateConfig(nextConfig, git);
  let privateSeeded = false;
  if (privateUrl && privateDir) {
    ({ seeded: privateSeeded } = setupContextRepo(privateUrl, privateDir));
    validatePrivateDestination(nextConfig, team, git);
  }
  saveConfig(nextConfig);
  console.log(`Team ${teamName}: ${dir}${seeded ? ' (seeded from the team template)' : ''}`);
  if (privateDir) {
    console.log(`Private repo (${teamName}): ${privateDir}${privateSeeded ? ' (seeded from the template)' : ''}`);
  }
  console.log(`Author in team sessions: ${slug(author ?? config.device)}`);
  console.log(`Share a project with: pctx team share ${teamName} (run it inside the project's repo)`);
  return 0;
}

function teamShare([name], values) {
  if (!name) throw new Error('Usage: pctx team share <name> [--project <name>] [--cwd <path>]');
  const config = requireConfig();
  const team = findTeam(config, name);
  if (!team) throw new Error(`No team named ${slug(name)}. Add it with: pctx team add <name> <git-url>`);
  const cwd = resolve(values.cwd ?? process.cwd());
  const resolved = resolveScope(config, {
    cwd,
    project: values.project,
    teamName: team.name,
    strictCwd: Boolean(values.cwd),
  });
  if (resolved.conflict) throw new Error(resolved.conflict);
  if (!resolved.projectId) throw new Error('Could not detect the project; pass --project <name>');
  if (!existsSync(join(team.dir, '.git'))) {
    throw new Error(`Team ${team.name} repo is missing at ${team.dir}`);
  }
  const { file, created } = shareProject(config, team, resolved.projectId);
  console.log(`${created ? 'Shared' : 'Already shared'}: ${resolved.projectId} in team ${team.name} (${file})`);
  if (team.isolated) {
    if (team.privateDir && existsSync(join(team.privateDir, 'projects', `${resolved.projectId}.md`))) {
      const priv = join(team.privateDir, 'projects', `${resolved.projectId}.md`);
      console.log(`Your private notes in ${priv} stay private; copy to the team file only what the team should read.`);
    }
  } else {
    const personalFile = join(config.contextDir, 'projects', `${resolved.projectId}.md`);
    const aliasFile = resolved.alias ? join(config.contextDir, 'projects', `${resolved.alias}.md`) : null;
    const foundPersonal = existsSync(personalFile) ? personalFile : aliasFile && existsSync(aliasFile) ? aliasFile : null;
    if (foundPersonal) {
      console.log(
        `Your private notes in ${foundPersonal} stay private; copy to the team file only what the team should read.`,
      );
    }
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
  const config = requireConfig();
  const teams = teamList(config);
  if (!teams.length) {
    console.log('No teams. Add one with: pctx team add <name> <git-url>');
    return 0;
  }
  for (const team of teams) {
    const tags = [];
    if (team.isolated) tags.push('isolated');
    if (hasScopeRules(team)) tags.push('scoped');
    if (team.privateDir) tags.push(`private: ${team.privateDir}`);
    const suffix = tags.length ? ` [${tags.join(', ')}]` : '';
    console.log(`${team.name}: ${redactUrl(team.url)} (${team.dir})${suffix}`);
  }
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

function runDoctor() {
  const config = requireConfig();
  const remote = git(config.contextDir, ['config', '--get', 'remote.origin.url']);
  console.log(`Device: ${config.device}`);
  console.log(`Context dir: ${config.contextDir}`);
  console.log(`Remote: ${remote.ok ? redactUrl(remote.stdout.trim()) : '(not found)'}`);
  console.log(`Project identity: ${config.projectIdentity ?? 'legacy'}`);
  const aliasCount = Object.keys(config.aliases ?? {}).length;
  if (aliasCount) console.log(`Aliases: ${aliasCount}`);
  if (config.author) console.log(`Author: ${config.author}`);
  if (Array.isArray(config.scanRules) && config.scanRules.length) {
    console.log(`Scan rules (context): ${config.scanRules.join(', ')}`);
  }
  try {
    validateConfig(config, git);
  } catch (err) {
    console.log(`Config problem: ${err.message}`);
  }
  for (const team of teamList(config)) {
    const found = existsSync(join(team.dir, '.git'));
    const flags = [];
    if (team.isolated) flags.push('isolated');
    if (team.remotes?.length) flags.push(`${team.remotes.length} remote(s)`);
    if (team.namespaces?.length) flags.push(`${team.namespaces.length} namespace(s)`);
    const tagText = flags.length ? ` [${flags.join(', ')}]` : '';
    console.log(
      `Team ${team.name}: ${redactUrl(team.url)} (${found ? team.dir : `missing clone at ${team.dir}`})${tagText}`,
    );
    if (Array.isArray(team.scanRules) && team.scanRules.length) {
      console.log(`Team ${team.name} scan rules: ${team.scanRules.join(', ')}`);
    }
    if (team.privateDir) {
      let privState = 'ok';
      try {
        validatePrivateDestination(config, team, git);
      } catch (err) {
        privState = `invalid: ${err.message}`;
      }
      console.log(`Team ${team.name} private: ${team.privateDir} (${privState})`);
      if (Array.isArray(team.privateScanRules) && team.privateScanRules.length) {
        console.log(`Team ${team.name} private scan rules: ${team.privateScanRules.join(', ')}`);
      }
    }
  }
  const state = (on) => (on ? 'installed' : 'missing');
  for (const item of status(config)) {
    if (!item.available) {
      console.log(`${item.name}: not found on this device`);
      continue;
    }
    const problem = item.problem ? ` (${item.problem})` : '';
    const rules = 'rules' in item ? `, sync rule ${state(item.rules)}` : '';
    console.log(`${item.name}: hook ${state(item.hook)}, skill ${state(item.skill)}${rules}${problem}`);
  }
  return 0;
}

function readHookInput() {
  try {
    if (process.stdin.isTTY) return {};
    const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
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
      const input = readHookInput();
      const workDir = hookWorkDir(input, antigravity);
      const compact = input.source === 'compact';
      const resolved = resolveScope(config, { cwd: workDir, allowConflict: true });
      const refreshOpts = { compact, intervalSeconds: resolveHookRefreshSeconds(config) };

      if (resolved.scopeKind === 'isolated' && resolved.isolatedTeam && !resolved.conflict) {
        const team = resolved.isolatedTeam;
        const teamResults = {};
        teamResults[team.name] = existsSync(join(team.dir, '.git'))
          ? hookRefresh(team.dir, deadline, { ...refreshOpts, isolated: true })
          : { ok: false, message: `no clone at ${team.dir}; run pctx team add again` };
        let privateResult = null;
        if (team.privateDir) {
          try {
            validatePrivateDestination(config, team, git);
            privateResult = hookRefresh(team.privateDir, deadline, { ...refreshOpts, isolated: true });
          } catch (err) {
            privateResult = { ok: false, unusable: true, message: err.message };
          }
        }
        text = buildContext(config, workDir, null, teamResults, { resolved, privateResult });
      } else if (resolved.conflict && (resolved.scopeKind === 'isolated' || resolved.isolatedTeam)) {
        text = `Portable context unavailable: ${resolved.conflict}`;
      } else {
        const personal = hookRefresh(config.contextDir, deadline, refreshOpts);
        // Personal hook never enumerates, refreshes, or pushes isolated teams.
        const nonIsolated = teamList(config).filter((t) => !t.isolated);
        const teams = [...nonIsolated].sort(
          (a, b) => (b.name === resolved.team?.name) - (a.name === resolved.team?.name),
        );
        const teamResults = {};
        for (const team of teams) {
          teamResults[team.name] = existsSync(join(team.dir, '.git'))
            ? hookRefresh(team.dir, deadline, refreshOpts)
            : { ok: false, message: `no clone at ${team.dir}; run pctx team add again` };
        }
        text = buildContext(config, workDir, personal, teamResults, { resolved });
      }
    }
  } catch (err) {
    text = `Portable context unavailable: ${String(err?.message ?? err).split(/\r?\n/)[0]}`;
  }
  printHookOutput(text, antigravity);
  return 0;
}

function runSessionPath(values) {
  const config = requireConfig();
  const cwd = resolve(values.cwd ?? process.cwd());
  const resolved = resolveScope(config, {
    cwd,
    project: values.project,
    teamName: values.team,
    strictCwd: Boolean(values.cwd),
  });
  if (resolved.conflict) throw new Error(resolved.conflict);
  const project = resolved.projectId ?? (resolved.mode === 'legacy' && !values.team ? 'general' : null);
  if (!project) {
    throw new Error('Could not resolve project; pass --cwd inside a project repo or --project <remote-or-id>');
  }

  let file;
  if (resolved.scopeKind === 'isolated') {
    const team = resolved.isolatedTeam;
    if (!existsSync(join(team.dir, '.git'))) {
      throw new Error(`Team ${team.name} repo is not available at ${team.dir}`);
    }
    if (values.private) {
      const targetDir = validatePrivateDestination(config, team, git);
      file = sessionPath(config, project, new Date(), team, targetDir);
    } else {
      file = sessionPath(config, project, new Date(), team);
    }
  } else {
    const targetDir = values.private ? config.contextDir : null;
    const team = values.private ? null : resolved.team;
    file = sessionPath(config, project, new Date(), team, targetDir);
  }
  mkdirSync(dirname(file), { recursive: true });
  console.log(file);
  return 0;
}

function targetRepos(config, values) {
  const cwd = resolve(values.cwd ?? process.cwd());
  const resolved = resolveScope(config, {
    cwd,
    teamName: values.team,
    strictCwd: Boolean(values.cwd),
  });
  if (resolved.conflict) throw new Error(resolved.conflict);
  if (resolved.scopeKind === 'isolated') {
    const team = resolved.isolatedTeam;
    const list = [{ label: `team ${team.name}`, dir: team.dir, team, scanRules: team.scanRules }];
    if (team.privateDir) {
      const privDir = validatePrivateDestination(config, team, git);
      list.push({ label: `private ${team.name}`, dir: privDir, privateOf: team, scanRules: team.privateScanRules });
    }
    return list;
  }
  if (values.team && resolved.team) {
    return [{ label: `team ${resolved.team.name}`, dir: resolved.team.dir, team: resolved.team, scanRules: resolved.team.scanRules }];
  }
  return [
    { label: 'context', dir: config.contextDir, scanRules: config.scanRules },
    ...teamList(config)
      .filter((t) => !t.isolated)
      .map((team) => ({ label: `team ${team.name}`, dir: team.dir, team, scanRules: team.scanRules })),
  ];
}

// Exit code: 0 all fine, 1 a pull or push failed, 2 a secret blocked a commit (the worst wins).
function reportSync(result, prefix) {
  if (result.status === 'synced' || result.status === 'up-to-date') {
    console.log(`${prefix}${result.status}`);
    return 0;
  }
  if (result.status === 'blocked') {
    const hasPii = result.findings.some((f) => isPersonalDataRule(f.rule));
    const kind = hasPii ? 'possible secrets or personal data' : 'possible secrets';
    console.error(`${prefix}blocked: ${kind} found, nothing was committed\n${formatFindings(result.findings)}`);
    return 2;
  }
  console.error(`${prefix}${result.status}: ${result.message}`);
  return 1;
}

function runSync(values) {
  const config = requireConfig();
  const all = targetRepos(config, values);
  let code = 0;
  for (const { label, dir, team, privateOf, scanRules } of all) {
    const prefix = all.length > 1 ? `${label}: ` : '';
    const isolated = Boolean(team?.isolated || privateOf?.isolated);
    const message = values.message || (team ? `context: update from ${config.author ?? config.device}` : undefined);
    const result = existsSync(join(dir, '.git'))
      ? sync(config, message, dir, { isolated, rules: scanRules })
      : { status: 'error', message: `no clone at ${dir}` };
    code = Math.max(code, reportSync(result, prefix));
  }
  return code;
}

function runScan(values) {
  const config = requireConfig();
  const targets = targetRepos(config, values);
  const missing = targets.find(({ team, dir }) => team && !existsSync(join(dir, '.git')));
  if (missing) throw new Error(`no clone at ${missing.dir}`);
  const all = targets.filter(({ dir }) => existsSync(join(dir, '.git')));
  let code = 0;
  for (const { label, dir, scanRules } of all) {
    const prefix = all.length > 1 ? `${label}: ` : '';
    let findings;
    try {
      findings = stagedFindings(dir, { rules: scanRules });
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
      return runScan(values);
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
