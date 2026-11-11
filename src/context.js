import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDiff } from './secrets.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../template/', import.meta.url));
export const TEAM_TEMPLATE_DIR = fileURLToPath(new URL('../template-team/', import.meta.url));
const PULL_TIMEOUT = 15_000;
// The SessionStart hook times out at 30s; every pull and push in the hook must end before this.
const HOOK_BUDGET = 25_000;
const MIN_REFRESH_TIME = 2_000;
// Pull plus push must stay under the 30s SessionStart hook timeout.
const REFRESH_PUSH_TIMEOUT = 10_000;
const SYNC_PUSH_TIMEOUT = 60_000;
const CLONE_TIMEOUT = 120_000;
const PROFILE_MAX = 3000;
const PROJECT_MAX = 4000;
const RECENT_SESSIONS = 3;

export function configDir() {
  return process.env.PCTX_HOME || join(os.homedir(), '.pctx');
}

export function slug(value) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'general';
}

export function defaultDevice() {
  return slug(os.hostname());
}

export function loadConfig() {
  const file = join(configDir(), 'config.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveConfig(cfg) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(join(configDir(), 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
}

export function git(cwd, args, { timeout } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Set when launched from inside a git hook; they would redirect us to another repo.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const result = spawnSync('git', args, {
    cwd,
    env,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

function identityArgs(dir) {
  const args = [];
  if (!git(dir, ['config', 'user.name']).stdout.trim()) args.push('-c', 'user.name=pctx');
  if (!git(dir, ['config', 'user.email']).stdout.trim()) args.push('-c', 'user.email=pctx@localhost');
  return args;
}

function copyTemplate(dir, templateDir) {
  for (const entry of readdirSync(templateDir)) {
    // npm can drop files named .gitignore from packages, hence the rename.
    const target = join(dir, entry === 'gitignore' ? '.gitignore' : entry);
    if (!existsSync(target)) cpSync(join(templateDir, entry), target, { recursive: true });
  }
}

function seedEmptyRepo(dir, templateDir) {
  copyTemplate(dir, templateDir);
  const steps = [
    ['checkout', '-q', '-B', 'main'],
    ['add', '-A'],
    [...identityArgs(dir), 'commit', '-q', '-m', 'context: initialize'],
    ['push', '-q', '-u', 'origin', 'main'],
  ];
  for (const args of steps) {
    const result = git(dir, args, { timeout: SYNC_PUSH_TIMEOUT });
    if (!result.ok) throw new Error(`Could not seed ${dir}: ${firstLine(result.stderr) || firstLine(result.stdout)}`);
  }
}

export function setupContextRepo(url, dir, templateDir = TEMPLATE_DIR) {
  const target = resolve(dir);
  if (existsSync(join(target, '.git'))) {
    const origin = git(target, ['config', '--get', 'remote.origin.url']).stdout.trim();
    if (origin !== url) {
      throw new Error(`${target} already has origin ${origin || '(none)'}, expected ${url}. If the repo moved, run: git -C "${target}" remote set-url origin ${url}`);
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    const clone = git(dirname(target), ['clone', '-q', '--', url, target], { timeout: CLONE_TIMEOUT });
    if (!clone.ok) throw new Error(`Could not clone ${url}: ${firstLine(clone.stderr)}`);
  }
  if (git(target, ['rev-parse', '--verify', '-q', 'HEAD']).ok) return { seeded: false };
  seedEmptyRepo(target, templateDir);
  return { seeded: true };
}

function rebaseInProgress(dir) {
  return existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'));
}

function stashCount(dir) {
  return git(dir, ['stash', 'list']).stdout.split('\n').filter(Boolean).length;
}

function pullRebase(dir, timeout = PULL_TIMEOUT) {
  const stashed = stashCount(dir);
  // Replaying local commits needs a committer identity too.
  const pull = git(dir, [...identityArgs(dir), 'pull', '-q', '--rebase', '--autostash'], { timeout });
  if (pull.ok) {
    // git exits 0 when the autostash cannot be reapplied, which would hide the user's edits.
    if (stashCount(dir) > stashed) {
      return { ok: false, message: `Uncommitted edits clash with newer changes and were moved to git stash; run "git stash pop" in ${dir}` };
    }
    return { ok: true };
  }
  if (rebaseInProgress(dir)) {
    git(dir, ['rebase', '--abort']);
    return { ok: false, conflict: true, message: `Conflict pulling the context repo; resolve it by hand in ${dir}` };
  }
  return { ok: false, message: `Could not pull: ${firstLine(pull.stderr) || 'git pull failed'}` };
}

function aheadCount(dir) {
  const result = git(dir, ['rev-list', '--count', '@{u}..HEAD']);
  return result.ok ? Number(result.stdout.trim()) || 0 : 0;
}

function push(dir, timeout) {
  const result = git(dir, ['push', '-q'], { timeout });
  if (result.ok) return { ok: true };
  return { ok: false, message: `Could not push: ${firstLine(result.stderr) || 'git push failed'}` };
}

// `deadline` (a Date.now() value) shortens the git timeouts so several repos fit in one hook run.
export function refresh(dir, deadline = Infinity) {
  const left = () => deadline - Date.now();
  if (left() < MIN_REFRESH_TIME) return { ok: false, message: 'Not refreshed: no time left in the session hook' };
  const pulled = pullRebase(dir, Math.min(PULL_TIMEOUT, left()));
  if (!pulled.ok) return { ok: false, message: pulled.message };
  // Retries saves that could not be pushed earlier, for example while offline.
  if (aheadCount(dir) > 0) {
    if (left() < MIN_REFRESH_TIME) return { ok: false, message: 'Pending saves not pushed: no time left in the session hook' };
    const pushed = push(dir, Math.min(REFRESH_PUSH_TIMEOUT, left()));
    if (!pushed.ok) return pushed;
  }
  return { ok: true };
}

export function hookDeadline(start = Date.now()) {
  return start + HOOK_BUDGET;
}

// ---------------------------------------------------------------- teams

export function teamList(config) {
  return Array.isArray(config?.teams) ? config.teams : [];
}

export function defaultTeamDir(name) {
  return join(configDir(), 'teams', slug(name));
}

export function findTeam(config, name) {
  return teamList(config).find((team) => team.name === slug(name)) ?? null;
}

function teamProjectFile(team, project) {
  return join(team.dir, 'projects', `${project}.md`);
}

// A project is shared when a team repo has notes for it. Two teams with the same project
// would mix their context, so that case loads neither and is reported instead.
export function resolveProjectTeam(config, project) {
  if (!project) return { team: null };
  const owners = teamList(config).filter((team) => existsSync(teamProjectFile(team, project)));
  if (owners.length > 1) {
    const names = owners.map((team) => team.name).join(', ');
    return {
      team: null,
      conflict: `Project ${project} has notes in more than one team (${names}); keep projects/${project}.md in only one team repo`,
    };
  }
  return { team: owners[0] ?? null };
}

export function shareProject(config, team, project) {
  const { team: owner, conflict } = resolveProjectTeam(config, project);
  if (conflict) throw new Error(conflict);
  if (owner && owner.name !== team.name) throw new Error(`Project ${project} is already shared in team ${owner.name}`);
  const file = teamProjectFile(team, project);
  if (existsSync(file)) return { file, created: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${project}\n\nShared notes for the team. Keep only the current state of the project.\n`);
  return { file, created: true };
}

function remoteName(url) {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop();
  return last.replace(/\.git$/i, '');
}

export function detectProject(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const origin = git(cwd, ['config', '--get', 'remote.origin.url']);
  if (origin.ok && origin.stdout.trim()) return slug(remoteName(origin.stdout));
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.ok && top.stdout.trim()) return slug(basename(top.stdout.trim()));
  return slug(basename(resolve(cwd)));
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

function truncate(text, max, fullPath) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Truncated. Full file: ${fullPath}]`;
}

function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
}

function listSection(title, names) {
  return names.length ? [`## ${title}\n\n${names.map((name) => `- ${name}`).join('\n')}`] : [];
}

function profileSection(dir) {
  const file = join(dir, 'AGENTS.md');
  const text = readIfExists(file);
  return text ? [`## Profile\n\n${truncate(text, PROFILE_MAX, file)}`] : [];
}

function projectSection(dir, project) {
  if (!project) return [];
  const file = join(dir, 'projects', `${project}.md`);
  const text = readIfExists(file);
  const body = text ? truncate(text, PROJECT_MAX, file) : `No notes yet (${file}).`;
  return [`## Current project: ${project}\n\n${body}`];
}

function teamProjectSections(dir, team, project) {
  const file = teamProjectFile(team, project);
  const text = readIfExists(file) ?? '';
  const sections = [];
  const teamProfile = readIfExists(join(team.dir, 'AGENTS.md'));
  if (teamProfile) sections.push(`## Team ${team.name}\n\n${truncate(teamProfile, PROFILE_MAX, join(team.dir, 'AGENTS.md'))}`);
  sections.push(
    `## Current project: ${project} (shared in team ${team.name})\n\n` +
      `Team repo: ${team.dir}. Everyone in the team reads its notes and sessions; save sessions of this project there.\n\n` +
      (text ? truncate(text, PROJECT_MAX, file) : `No notes yet (${file}).`),
  );
  // Notes kept in the personal repo before the project was shared stay private.
  const privateFile = join(dir, 'projects', `${project}.md`);
  const privateText = readIfExists(privateFile);
  if (privateText) sections.push(`## Your private notes for ${project}\n\n${truncate(privateText, PROJECT_MAX, privateFile)}`);
  return sections;
}

function recentSessions(dir, project) {
  if (!project) return [];
  return markdownFiles(join(dir, 'sessions')).filter((name) => name.includes(`-${project}-`)).slice(-RECENT_SESSIONS);
}

function warningLine(label, result) {
  if (!result || result.ok) return [];
  return [`WARNING: ${label} may be out of date (${result.message ?? 'sync failed'}). Tell the user.`];
}

// `teamResults` maps a team name to the result of refreshing that team repo.
export function buildContext(config, cwd, syncResult, teamResults = {}) {
  const dir = config.contextDir;
  const teams = teamList(config);
  const project = detectProject(cwd);
  const { team, conflict } = resolveProjectTeam(config, project);
  const others = markdownFiles(join(dir, 'projects')).filter((name) => name !== `${project}.md`);
  for (const t of teams) {
    for (const name of markdownFiles(join(t.dir, 'projects'))) {
      if (name !== `${project}.md`) others.push(`${name} (team ${t.name})`);
    }
  }
  const teamHeader = teams.length ? [`Team repos: ${teams.map((t) => `${t.name} (${t.dir})`).join(', ')}`] : [];
  const teamSessions = team ? recentSessions(team.dir, project) : [];
  return [
    '# Portable context',
    `Context repo: ${dir}`,
    ...teamHeader,
    ...warningLine('the context', syncResult),
    ...teams.flatMap((t) => warningLine(`team ${t.name}`, teamResults[t.name])),
    ...(conflict ? [`WARNING: ${conflict}. Tell the user.`] : []),
    ...profileSection(dir),
    ...(team ? teamProjectSections(dir, team, project) : projectSection(dir, project)),
    ...listSection('Other projects', others),
    ...listSection('Recent sessions for this project', recentSessions(dir, project)),
    ...listSection(`Recent team sessions for this project (${join(team?.dir ?? '', 'sessions')})`, teamSessions),
  ].join('\n\n');
}

// Sessions of a shared project go to its team repo and carry the author, so the team knows who wrote them.
export function sessionPath(config, project, now = new Date(), team = null) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const device = slug(config.device);
  if (team) {
    const author = slug(config.author ?? device);
    const who = author === device ? author : `${author}-${device}`;
    return join(team.dir, 'sessions', `${date}-${time}-${slug(project)}-${who}.md`);
  }
  return join(config.contextDir, 'sessions', `${date}-${time}-${slug(project)}-${device}.md`);
}

export function stagedFindings(dir) {
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${firstLine(add.stderr)}`);
  // --text and the fixed prefixes keep user config and .gitattributes from hiding content from the scan.
  const diff = git(dir, [
    '-c', 'core.quotepath=off',
    'diff', '--cached', '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/',
  ]);
  if (!diff.ok) throw new Error(`git diff failed: ${firstLine(diff.stderr)}`);
  return scanDiff(diff.stdout);
}

function commitStaged(dir, message) {
  if (!git(dir, ['status', '--porcelain']).stdout.trim()) return { committed: false };
  const commit = git(dir, [...identityArgs(dir), 'commit', '-q', '-m', message]);
  if (commit.ok) return { committed: true };
  return { committed: false, error: firstLine(commit.stderr) || firstLine(commit.stdout) || 'git commit failed' };
}

export function sync(config, message, dir = config.contextDir) {
  let findings;
  try {
    findings = stagedFindings(dir);
  } catch (err) {
    return { status: 'error', message: err.message };
  }
  if (findings.length) {
    git(dir, ['reset', '-q']);
    return { status: 'blocked', findings };
  }

  const { committed, error } = commitStaged(dir, message || `context: update from ${config.device}`);
  if (error) return { status: 'error', message: error };

  const pulled = pullRebase(dir);
  if (!pulled.ok) return { status: 'local-only', message: pulled.message, committed };

  const ahead = aheadCount(dir);
  if (ahead > 0) {
    const pushed = push(dir, SYNC_PUSH_TIMEOUT);
    if (!pushed.ok) return { status: 'local-only', message: pushed.message, committed };
  }
  return { status: committed || ahead > 0 ? 'synced' : 'up-to-date', committed };
}
