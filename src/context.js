import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDiff } from './secrets.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../template/', import.meta.url));
const PULL_TIMEOUT = 15_000;
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

function copyTemplate(dir) {
  for (const entry of readdirSync(TEMPLATE_DIR)) {
    // npm can drop files named .gitignore from packages, hence the rename.
    const target = join(dir, entry === 'gitignore' ? '.gitignore' : entry);
    if (!existsSync(target)) cpSync(join(TEMPLATE_DIR, entry), target, { recursive: true });
  }
}

function seedEmptyRepo(dir) {
  copyTemplate(dir);
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

export function setupContextRepo(url, dir) {
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
  seedEmptyRepo(target);
  return { seeded: true };
}

function rebaseInProgress(dir) {
  return existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'));
}

function stashCount(dir) {
  return git(dir, ['stash', 'list']).stdout.split('\n').filter(Boolean).length;
}

function pullRebase(dir) {
  const stashed = stashCount(dir);
  // Replaying local commits needs a committer identity too.
  const pull = git(dir, [...identityArgs(dir), 'pull', '-q', '--rebase', '--autostash'], { timeout: PULL_TIMEOUT });
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

export function refresh(dir) {
  const pulled = pullRebase(dir);
  if (!pulled.ok) return { ok: false, message: pulled.message };
  // Retries saves that could not be pushed earlier, for example while offline.
  if (aheadCount(dir) > 0) {
    const pushed = push(dir, REFRESH_PUSH_TIMEOUT);
    if (!pushed.ok) return pushed;
  }
  return { ok: true };
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

export function buildContext(config, cwd, syncResult) {
  const dir = config.contextDir;
  const project = detectProject(cwd);
  const others = markdownFiles(join(dir, 'projects')).filter((name) => name !== `${project}.md`);
  const sessions = project
    ? markdownFiles(join(dir, 'sessions')).filter((name) => name.includes(`-${project}-`)).slice(-RECENT_SESSIONS)
    : [];
  const warning =
    syncResult && !syncResult.ok
      ? [`WARNING: the context may be out of date (${syncResult.message ?? 'sync failed'}). Tell the user.`]
      : [];
  return [
    '# Portable context',
    `Context repo: ${dir}`,
    ...warning,
    ...profileSection(dir),
    ...projectSection(dir, project),
    ...listSection('Other projects', others),
    ...listSection('Recent sessions for this project', sessions),
  ].join('\n\n');
}

export function sessionPath(config, project, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return join(config.contextDir, 'sessions', `${date}-${time}-${slug(project)}-${slug(config.device)}.md`);
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

export function sync(config, message) {
  const dir = config.contextDir;
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
