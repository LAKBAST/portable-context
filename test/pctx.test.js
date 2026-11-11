import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'pctx.js');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const real = (p) => fs.realpathSync.native(p);
const fakeGithubToken = () => 'ghp_' + 'a'.repeat(36);

function baseEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(args, opts = {}) {
  const { allowFail, ...rest } = opts;
  const r = spawnSync('git', args, { encoding: 'utf8', env: baseEnv(), ...rest });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r;
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-test-'));
  tmpDirs.push(root);
  const remote = path.join(root, 'remote.git');
  git(['init', '--bare', '-b', 'main', remote]);
  return { root, remote };
}

function makeDevice(sandbox, name, { claude = true, codex = true, antigravity = false } = {}) {
  const home = path.join(sandbox.root, name, 'home');
  const d = {
    name,
    home,
    pctxHome: path.join(sandbox.root, name, 'pctx'),
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    antigravity: path.join(home, '.gemini', 'config'),
    work: path.join(sandbox.root, name, 'work'),
  };
  d.plugin = path.join(d.antigravity, 'plugins', 'portable-context');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(d.work, { recursive: true });
  if (claude) fs.mkdirSync(d.claude, { recursive: true });
  if (codex) fs.mkdirSync(d.codex, { recursive: true });
  if (antigravity) fs.mkdirSync(d.antigravity, { recursive: true });
  d.context = path.join(d.pctxHome, 'context');
  d.env = {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    PCTX_HOME: d.pctxHome,
    CLAUDE_CONFIG_DIR: d.claude,
    CODEX_HOME: d.codex,
    ANTIGRAVITY_CONFIG_DIR: d.antigravity,
  };
  return d;
}

function pctx(device, args, { input = '', cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: device.env,
    cwd: cwd ?? device.work,
    input,
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function setup(device, sandbox, extra = []) {
  const r = pctx(device, ['setup', sandbox.remote, '--device', device.name, ...extra]);
  assert.equal(r.status, 0, `setup failed: ${r.stdout}\n${r.stderr}`);
  return r;
}

function hook(device, cwd) {
  return pctx(device, ['hook'], { input: JSON.stringify({ cwd }) });
}

function remoteFiles(sandbox) {
  const r = git(['--git-dir', sandbox.remote, 'ls-tree', '-r', '--name-only', 'main']);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function remoteHead(sandbox) {
  const r = git(['--git-dir', sandbox.remote, 'rev-parse', 'main'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function localHead(device) {
  return git(['-C', device.context, 'rev-parse', 'HEAD']).stdout.trim();
}

function commitCount(device) {
  return Number(git(['-C', device.context, 'rev-list', '--count', 'HEAD']).stdout.trim());
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pctxCommands(file) {
  const json = readJson(file);
  const out = [];
  for (const entry of json.hooks?.SessionStart ?? []) {
    for (const h of entry.hooks ?? []) {
      if (typeof h.command === 'string' && h.command.includes('pctx.js')) out.push(h.command);
    }
  }
  return out;
}

function offline(sandbox) {
  fs.renameSync(sandbox.remote, sandbox.remote + '.off');
}
function online(sandbox) {
  fs.renameSync(sandbox.remote + '.off', sandbox.remote);
}

function newSession(device, project, body) {
  const r = pctx(device, ['session-path', '--project', project, '--cwd', device.work]);
  assert.equal(r.status, 0, r.stderr);
  const file = r.stdout.trim().split(/\r?\n/).pop();
  write(file, body);
  return file;
}

const ORIGINAL_SETTINGS = {
  theme: 'dark',
  permissions: { allow: ['Bash(ls)'] },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo other-hook' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
  },
};

const FOREIGN_SKILL = '---\nname: save-context\n---\nMy own skill\n';

// ---------------------------------------------------------------- setup

test('setup seeds an empty repo from the template and saves config', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);

  const files = remoteFiles(sb);
  for (const f of ['AGENTS.md', 'README.md', '.gitignore']) {
    assert.ok(files.includes(f), `remote should contain ${f}, has ${files}`);
  }
  const cfg = readJson(path.join(a.pctxHome, 'config.json'));
  assert.equal(cfg.device, 'laptop');
  assert.equal(cfg.skillName, 'save-context');
  assert.equal(real(cfg.contextDir), real(a.context));
  assert.ok(fs.existsSync(path.join(a.context, 'AGENTS.md')));
});

test('setup honours --skill-name', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb, ['--skill-name', 'ctx-save']);
  assert.equal(readJson(path.join(a.pctxHome, 'config.json')).skillName, 'ctx-save');
  assert.ok(fs.existsSync(path.join(a.claude, 'skills', 'ctx-save', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(a.home, '.agents', 'skills', 'ctx-save', 'SKILL.md')));
});

test('setup installs only for homes that exist', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { codex: false });
  setup(a, sb);
  assert.equal(pctxCommands(path.join(a.claude, 'settings.json')).length, 1);
  const skill = fs.readFileSync(path.join(a.claude, 'skills', 'save-context', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('managed-by: portable-context'));
  assert.ok(!fs.existsSync(a.codex));
  assert.ok(!fs.existsSync(path.join(a.home, '.agents', 'skills', 'save-context')));
});

test('setup installs the Codex hook and skill when CODEX_HOME exists', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  assert.equal(pctxCommands(path.join(a.codex, 'hooks.json')).length, 1);
  assert.ok(fs.existsSync(path.join(a.home, '.agents', 'skills', 'save-context', 'SKILL.md')));
});

// ---------------------------------------------------------------- multi device

test('a second device sees what the first device saved', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  const marker = 'MARKER-' + 'x'.repeat(8);
  const file = newSession(a, 'myproj', `# Session\n${marker}\n`);
  const s = pctx(a, ['sync']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /synced/);

  setup(b, sb);
  const projDir = path.join(b.work, 'myproj');
  fs.mkdirSync(projDir, { recursive: true });
  const h = hook(b, projDir);
  assert.equal(h.status, 0);
  assert.ok(h.stdout.includes('# Portable context'));
  assert.ok(h.stdout.includes('## Recent sessions for this project'));
  assert.ok(h.stdout.includes(marker) || h.stdout.includes(path.basename(file)),
    'hook output should reference the first device session');
});

test('two devices saving different sessions both reach the remote', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  setup(b, sb);

  const fa = newSession(a, 'myproj', '# A session\n');
  const fb = newSession(b, 'myproj', '# B session\n');
  assert.notEqual(path.basename(fa), path.basename(fb));

  const sa = pctx(a, ['sync']);
  assert.equal(sa.status, 0, sa.stderr);
  const sbb = pctx(b, ['sync']);
  assert.equal(sbb.status, 0, sbb.stderr);

  const files = remoteFiles(sb);
  assert.ok(files.includes('sessions/' + path.basename(fa)), files.join(','));
  assert.ok(files.includes('sessions/' + path.basename(fb)), files.join(','));
});

// ---------------------------------------------------------------- hook

test('hook loads the right project and lists the others', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  write(path.join(a.context, 'projects', 'alpha.md'), '# alpha\nALPHA-NOTES\n');
  write(path.join(a.context, 'projects', 'beta.md'), '# beta\nBETA-NOTES\n');
  assert.equal(pctx(a, ['sync']).status, 0);

  const cwd = path.join(a.work, 'alpha');
  fs.mkdirSync(cwd, { recursive: true });
  const h = hook(a, cwd);
  assert.equal(h.status, 0);
  const out = h.stdout;
  assert.ok(out.includes('# Portable context'));
  assert.ok(out.includes('## Profile'));
  assert.ok(out.includes('## Current project: alpha'));
  assert.ok(out.includes('## Other projects'));
  const iCur = out.indexOf('## Current project: alpha');
  assert.ok(out.indexOf('ALPHA-NOTES') > iCur, 'alpha notes belong to the current project');
  assert.ok(!out.includes('## Current project: beta'));
  assert.ok(!out.includes('WARNING'));
});

test('hook derives the project slug from the origin remote basename', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  write(path.join(a.context, 'projects', 'cool-app.md'), '# cool\nCOOL-NOTES\n');
  assert.equal(pctx(a, ['sync']).status, 0);

  const cwd = path.join(a.work, 'some-checkout-folder');
  fs.mkdirSync(cwd, { recursive: true });
  git(['init', '-q', '-b', 'main', cwd]);
  git(['-C', cwd, 'remote', 'add', 'origin', 'https://example.com/someone/cool-app.git']);
  const h = hook(a, cwd);
  assert.equal(h.status, 0);
  assert.ok(h.stdout.includes('## Current project: cool-app'), h.stdout);
  assert.ok(h.stdout.includes('COOL-NOTES'));
});

test('hook with an unreachable remote prints WARNING, still prints context, exits 0', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  offline(sb);
  const h = hook(a, a.work);
  assert.equal(h.status, 0);
  assert.ok(h.stdout.includes('WARNING'), h.stdout);
  assert.ok(h.stdout.includes('# Portable context'));
});

test('hook without config exits 0 and prints nothing', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const h = hook(a, a.work);
  assert.equal(h.status, 0);
  assert.equal(h.stdout.trim(), '');
});

test('hook tolerates empty stdin', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const h = pctx(a, ['hook'], { input: '' });
  assert.equal(h.status, 0);
});

// ---------------------------------------------------------------- sync / scan

test('sync reports up-to-date when nothing changed', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const s = pctx(a, ['sync']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /up-to-date/);
});

test('sync blocks a secret, never prints it, and makes no commit', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const before = localHead(a);
  const remoteBefore = remoteHead(sb);
  const secret = fakeGithubToken();
  write(path.join(a.context, 'projects', 'leaky.md'), `line one\napi = ${secret}\n`);

  const s = pctx(a, ['sync']);
  assert.equal(s.status, 2, `${s.stdout}\n${s.stderr}`);
  assert.ok(!s.stdout.includes(secret) && !s.stderr.includes(secret), 'secret value leaked');
  assert.match(s.stderr, /leaky\.md:2 \(/);
  assert.equal(localHead(a), before, 'no commit should be made');
  assert.equal(remoteHead(sb), remoteBefore);
});

test('scan reports clean, then findings with exit 2', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const clean = pctx(a, ['scan']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /clean/);

  const secret = fakeGithubToken();
  write(path.join(a.context, 'projects', 'leaky.md'), `x\n${secret}\n`);
  const dirty = pctx(a, ['scan']);
  assert.equal(dirty.status, 2);
  const all = dirty.stdout + dirty.stderr;
  assert.match(all, /leaky\.md:2/);
  assert.ok(!all.includes(secret));
});

test('sync offline gives local-only and the next hook pushes it', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const countBefore = commitCount(a);
  write(path.join(a.context, 'projects', 'offline.md'), '# offline\n');
  offline(sb);

  const s = pctx(a, ['sync']);
  assert.equal(s.status, 1, `${s.stdout}\n${s.stderr}`);
  assert.match(s.stderr, /local-only: /);
  assert.equal(commitCount(a), countBefore + 1, 'commit kept locally');

  online(sb);
  assert.ok(!remoteFiles(sb).includes('projects/offline.md'));
  const h = hook(a, a.work);
  assert.equal(h.status, 0);
  assert.ok(remoteFiles(sb).includes('projects/offline.md'), 'hook should have pushed');
});

test('conflicting edits to the same project file give local-only and no stuck rebase', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  setup(b, sb);

  write(path.join(a.context, 'projects', 'shared.md'), 'base\n');
  assert.equal(pctx(a, ['sync']).status, 0);
  assert.equal(hook(b, b.work).status, 0); // b pulls

  write(path.join(a.context, 'projects', 'shared.md'), 'edit from A\n');
  assert.equal(pctx(a, ['sync']).status, 0);

  write(path.join(b.context, 'projects', 'shared.md'), 'edit from B\n');
  const s = pctx(b, ['sync']);
  assert.equal(s.status, 1, `${s.stdout}\n${s.stderr}`);
  assert.match(s.stderr, /local-only: /);

  const gitDir = path.join(b.context, '.git');
  assert.ok(!fs.existsSync(path.join(gitDir, 'rebase-merge')), 'rebase-merge left behind');
  assert.ok(!fs.existsSync(path.join(gitDir, 'rebase-apply')), 'rebase-apply left behind');
  assert.ok(!fs.existsSync(path.join(gitDir, 'MERGE_HEAD')), 'merge left behind');
  const status = git(['-C', b.context, 'status', '--porcelain']).stdout;
  assert.ok(!/^(UU|AA|DD|U.|.U)/m.test(status), `unmerged paths: ${status}`);
  const remoteText = git(['--git-dir', sb.remote, 'show', 'main:projects/shared.md']).stdout;
  assert.equal(remoteText.replace(/\r\n/g, '\n'), 'edit from A\n');
});

test('hook warns when uncommitted edits clash with newer changes and keeps them in the stash', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  setup(b, sb);

  write(path.join(a.context, 'AGENTS.md'), 'profile from A\n');
  assert.equal(pctx(a, ['sync']).status, 0);
  write(path.join(b.context, 'AGENTS.md'), 'unsaved profile from B\n');

  const h = hook(b, b.work);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /WARNING: .*git stash/);
  const stashed = git(['-C', b.context, 'stash', 'list']).stdout;
  assert.ok(stashed.trim(), 'the edits should still be in the stash');
  const kept = git(['-C', b.context, 'show', 'stash@{0}:AGENTS.md']).stdout;
  assert.match(kept, /unsaved profile from B/);
});

test('hook keeps uncommitted edits in place when they do not clash', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  setup(b, sb);

  write(path.join(a.context, 'projects', 'other.md'), 'from A\n');
  assert.equal(pctx(a, ['sync']).status, 0);
  write(path.join(b.context, 'AGENTS.md'), 'unsaved profile from B\n');

  const h = hook(b, b.work);
  assert.doesNotMatch(h.stdout, /WARNING/);
  assert.match(fs.readFileSync(path.join(b.context, 'AGENTS.md'), 'utf8'), /unsaved profile from B/);
  assert.equal(git(['-C', b.context, 'stash', 'list']).stdout.trim(), '');
});

test('setup with a new --skill-name removes the old skill', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  setup(a, sb, ['--skill-name', 'guardar']);
  assert.ok(fs.existsSync(path.join(a.claude, 'skills', 'guardar', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(a.claude, 'skills', 'save-context')));
  assert.ok(!fs.existsSync(path.join(a.home, '.agents', 'skills', 'save-context')));
});

test('setup refused by a foreign skill keeps the previous skill name', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  write(path.join(a.claude, 'skills', 'taken', 'SKILL.md'), FOREIGN_SKILL);
  const r = pctx(a, ['setup', sb.remote, '--device', a.name, '--skill-name', 'taken']);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(readJson(path.join(a.pctxHome, 'config.json')).skillName, 'save-context');
  assert.ok(fs.existsSync(path.join(a.claude, 'skills', 'save-context', 'SKILL.md')));
});

test('setup against a moved repo explains how to update the remote', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const r = pctx(a, ['setup', `${sb.remote}-moved`, '--device', a.name]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /remote set-url origin/);
});

test('the Codex context limit sits on the hook, not on the matcher entry', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const [entry] = readJson(path.join(a.codex, 'hooks.json')).hooks.SessionStart;
  assert.equal(entry.additionalContextLimit, undefined);
  assert.equal(entry.hooks[0].additionalContextLimit, 9000);
});

// ---------------------------------------------------------------- install / uninstall

test('install preserves existing settings and hooks and creates a backup', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const settings = path.join(a.claude, 'settings.json');
  write(settings, JSON.stringify(ORIGINAL_SETTINGS, null, 2));
  setup(a, sb);

  const json = readJson(settings);
  assert.equal(json.theme, 'dark');
  assert.deepEqual(json.permissions, ORIGINAL_SETTINGS.permissions);
  assert.deepEqual(json.hooks.PreToolUse, ORIGINAL_SETTINGS.hooks.PreToolUse);
  const cmds = json.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(cmds.includes('echo other-hook'));
  assert.equal(pctxCommands(settings).length, 1);

  const backup = settings + '.pctx-backup';
  assert.ok(fs.existsSync(backup));
  assert.deepEqual(readJson(backup), ORIGINAL_SETTINGS);
});

test('install is idempotent and never duplicates the hook', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const files = [path.join(a.claude, 'settings.json'), path.join(a.codex, 'hooks.json')];
  const first = files.map((f) => fs.readFileSync(f, 'utf8'));
  for (let i = 0; i < 2; i++) {
    const r = pctx(a, ['install']);
    assert.equal(r.status, 0, r.stderr);
  }
  files.forEach((f, i) => {
    assert.equal(pctxCommands(f).length, 1);
    assert.equal(fs.readFileSync(f, 'utf8'), first[i]);
  });
});

test('install fails on invalid JSON and leaves the file unchanged', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const settings = path.join(a.claude, 'settings.json');
  const broken = '{ "theme": "dark", ';
  fs.writeFileSync(settings, broken);
  const r = pctx(a, ['install']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), broken);
});

test('install does not overwrite a foreign SKILL.md', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const skill = path.join(a.claude, 'skills', 'save-context', 'SKILL.md');
  fs.writeFileSync(skill, FOREIGN_SKILL);
  const r = pctx(a, ['install']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(skill, 'utf8'), FOREIGN_SKILL);
});

test('uninstall removes only our hook and skill and restores the settings', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const settings = path.join(a.claude, 'settings.json');
  write(settings, JSON.stringify(ORIGINAL_SETTINGS, null, 2));
  setup(a, sb);
  assert.equal(pctxCommands(settings).length, 1);

  const r = pctx(a, ['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJson(settings), ORIGINAL_SETTINGS);
  assert.ok(!fs.existsSync(path.join(a.claude, 'skills', 'save-context', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(a.home, '.agents', 'skills', 'save-context', 'SKILL.md')));
  assert.equal(pctxCommands(path.join(a.codex, 'hooks.json')).length, 0);
  assert.ok(fs.existsSync(path.join(a.context, 'AGENTS.md')), 'context repo is kept');
});

test('uninstall keeps a foreign SKILL.md', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const skill = path.join(a.claude, 'skills', 'save-context', 'SKILL.md');
  fs.writeFileSync(skill, FOREIGN_SKILL);
  pctx(a, ['uninstall']);
  assert.equal(fs.readFileSync(skill, 'utf8'), FOREIGN_SKILL);
});

test('doctor runs after setup and exits 0', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const r = pctx(a, ['doctor']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('session-path prints a dated file name and creates sessions/', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const r = pctx(a, ['session-path', '--project', 'myproj']);
  assert.equal(r.status, 0, r.stderr);
  const p = r.stdout.trim();
  assert.match(path.basename(p), /^\d{4}-\d{2}-\d{2}-\d{4}-myproj-laptop\.md$/);
  assert.equal(real(path.dirname(p)), real(path.join(a.context, 'sessions')));
});

// ---------------------------------------------------------------- antigravity

function antigravityCommands(device) {
  const file = path.join(device.plugin, 'hooks.json');
  if (!fs.existsSync(file)) return [];
  return Object.values(readJson(file))
    .flatMap((spec) => spec.SessionStart ?? [])
    .map((h) => h.command)
    .filter((c) => typeof c === 'string' && c.includes('pctx.js'));
}

test('setup skips Antigravity when its config dir does not exist', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const r = setup(a, sb);
  assert.ok(!r.stdout.includes('antigravity'), r.stdout);
  assert.ok(!fs.existsSync(a.antigravity));
});

test('setup installs the Antigravity plugin with hook and skill', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  const r = setup(a, sb, ['--skill-name', 'guardar']);
  assert.ok(r.stdout.includes('antigravity'), r.stdout);
  assert.equal(readJson(path.join(a.plugin, 'plugin.json')).name, 'portable-context');
  const commands = antigravityCommands(a);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].endsWith('hook --format antigravity'), commands[0]);
  const skill = fs.readFileSync(path.join(a.plugin, 'skills', 'guardar', 'SKILL.md'), 'utf8');
  assert.ok(skill.startsWith('---\nname: guardar\n'));
  assert.ok(skill.includes('managed-by: portable-context'));
});

test('install is idempotent for Antigravity', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  setup(a, sb);
  const file = path.join(a.plugin, 'hooks.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(pctx(a, ['install']).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(antigravityCommands(a).length, 1);
});

test('install refuses a foreign portable-context plugin folder and changes nothing', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  write(path.join(a.plugin, 'plugin.json'), '{"name":"portable-context"}');
  const r = pctx(a, ['setup', sb.remote, '--device', 'laptop']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not managed by pctx/);
  assert.ok(!fs.existsSync(path.join(a.plugin, 'hooks.json')));
  assert.ok(!fs.existsSync(path.join(a.claude, 'settings.json')), 'other targets untouched');
});

test('uninstall removes the Antigravity plugin but keeps files the user added', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  setup(a, sb);
  const r = pctx(a, ['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('antigravity'), r.stdout);
  assert.ok(!fs.existsSync(a.plugin));

  setup(a, sb);
  write(path.join(a.plugin, 'rules', 'mine.md'), 'keep me');
  pctx(a, ['uninstall']);
  assert.ok(!fs.existsSync(path.join(a.plugin, 'hooks.json')));
  assert.ok(!fs.existsSync(path.join(a.plugin, 'skills')));
  assert.ok(fs.existsSync(path.join(a.plugin, 'rules', 'mine.md')));
});

test('doctor reports the Antigravity integration', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  setup(a, sb);
  const r = pctx(a, ['doctor']);
  assert.match(r.stdout, /antigravity: hook installed, skill installed/);
});

test('hook --format antigravity prints injectSteps for the first workspace', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  setup(a, sb);
  const work = path.join(a.work, 'my-app');
  fs.mkdirSync(work, { recursive: true });
  const r = pctx(a, ['hook', '--format', 'antigravity'], {
    input: JSON.stringify({ conversationId: 'x', workspacePaths: [work] }),
    cwd: a.plugin,
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  const text = out.injectSteps[0].systemMessage.systemMessage;
  assert.ok(text.includes('# Portable context'));
  assert.ok(text.includes('Current project: my-app'), text);
});

test('hook --format antigravity prints {} without config and on bad input', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  const r = pctx(a, ['hook', '--format', 'antigravity'], { input: 'not json' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {});
});

// ---------------------------------------------------------------- teams

function makeRemote(sandbox, name) {
  const remote = path.join(sandbox.root, `${name}.git`);
  git(['init', '--bare', '-b', 'main', remote]);
  return remote;
}

function remoteFilesOf(remote) {
  const r = git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function teamAdd(device, name, url, extra = []) {
  const r = pctx(device, ['team', 'add', name, url, ...extra]);
  assert.equal(r.status, 0, `team add failed: ${r.stdout}\n${r.stderr}`);
  return r;
}

function projectDir(device, name) {
  const dir = path.join(device.work, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Two people, each with a private context repo, sharing one team repo.
function twoPeople() {
  const sb = makeSandbox();
  const team = makeRemote(sb, 'team');
  const otherRemote = makeRemote(sb, 'bob-context');
  const alice = makeDevice(sb, 'alice-laptop');
  const bob = makeDevice(sb, 'bob-pc');
  setup(alice, sb, ['--author', 'alice']);
  const r = pctx(bob, ['setup', otherRemote, '--device', bob.name, '--author', 'bob']);
  assert.equal(r.status, 0, r.stderr);
  return { sb, team, alice, bob };
}

test('team add seeds the team repo from the team template and saves it in the config', () => {
  const { team, alice } = twoPeople();
  const r = teamAdd(alice, 'Studio', team);
  assert.match(r.stdout, /seeded from the team template/);
  const files = remoteFilesOf(team);
  for (const f of ['AGENTS.md', 'README.md', '.gitignore']) assert.ok(files.includes(f), files.join(','));
  const cfg = readJson(path.join(alice.pctxHome, 'config.json'));
  assert.equal(cfg.teams.length, 1);
  assert.equal(cfg.teams[0].name, 'studio');
  assert.equal(cfg.author, 'alice');
  assert.match(pctx(alice, ['team', 'list']).stdout, /^studio: /m);
});

test('a teammate sees the shared project and sessions but nothing private', () => {
  const { team, alice, bob } = twoPeople();
  teamAdd(alice, 'studio', team);
  write(path.join(alice.context, 'AGENTS.md'), '# Profile\nALICE-PRIVATE-PROFILE\n');
  write(path.join(alice.context, 'projects', 'secret-proj.md'), '# secret\nALICE-SECRET-PROJECT\n');
  write(path.join(alice.context, 'projects', 'shared-app.md'), '# old\nALICE-PRIVATE-NOTES\n');

  const share = pctx(alice, ['team', 'share', 'studio', '--project', 'shared-app']);
  assert.equal(share.status, 0, share.stderr);
  assert.match(share.stdout, /stay private/);
  const teamDir = path.join(alice.pctxHome, 'teams', 'studio');
  write(path.join(teamDir, 'projects', 'shared-app.md'), '# shared-app\nTEAM-NOTES\n');
  const session = newSession(alice, 'shared-app', '# Session\nALICE-SESSION\n');
  assert.equal(real(path.dirname(session)), real(path.join(teamDir, 'sessions')));
  assert.match(path.basename(session), /-shared-app-alice-alice-laptop\.md$/);

  const s = pctx(alice, ['sync']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /^context: synced/m);
  assert.match(s.stdout, /^team studio: synced/m);

  const teamFiles = remoteFilesOf(team).join('\n');
  assert.ok(!teamFiles.includes('secret-proj'), teamFiles);
  assert.ok(teamFiles.includes('sessions/' + path.basename(session)), teamFiles);

  teamAdd(bob, 'studio', team);
  const h = hook(bob, projectDir(bob, 'shared-app'));
  assert.equal(h.status, 0);
  assert.ok(h.stdout.includes('## Current project: shared-app (shared in team studio)'), h.stdout);
  assert.ok(h.stdout.includes('TEAM-NOTES'));
  assert.ok(h.stdout.includes('## Team studio'));
  assert.ok(h.stdout.includes(path.basename(session)), 'bob should see the session alice saved');
  for (const secret of ['ALICE-PRIVATE-PROFILE', 'ALICE-SECRET-PROJECT', 'ALICE-PRIVATE-NOTES', 'secret-proj']) {
    assert.ok(!h.stdout.includes(secret), `bob must not see ${secret}`);
  }
  assert.ok(!h.stdout.includes('WARNING'), h.stdout);

  const own = hook(alice, projectDir(alice, 'shared-app'));
  assert.ok(own.stdout.includes('## Your private notes for shared-app'));
  assert.ok(own.stdout.includes('ALICE-PRIVATE-NOTES'));
});

test('projects that are not shared keep sessions in the personal repo', () => {
  const { team, alice } = twoPeople();
  teamAdd(alice, 'studio', team);
  const r = pctx(alice, ['session-path', '--project', 'solo']);
  assert.equal(real(path.dirname(r.stdout.trim())), real(path.join(alice.context, 'sessions')));
  assert.match(path.basename(r.stdout.trim()), /-solo-alice-laptop\.md$/);
  const h = hook(alice, projectDir(alice, 'solo'));
  assert.ok(h.stdout.includes('## Current project: solo\n'), h.stdout);
});

test('a project shared in two teams loads neither and session-path refuses', () => {
  const { sb, team, alice } = twoPeople();
  const team2 = makeRemote(sb, 'team2');
  teamAdd(alice, 'one', team);
  teamAdd(alice, 'two', team2);
  assert.equal(pctx(alice, ['team', 'share', 'one', '--project', 'app']).status, 0);
  const again = pctx(alice, ['team', 'share', 'two', '--project', 'app']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already shared in team one/);

  write(path.join(alice.pctxHome, 'teams', 'two', 'projects', 'app.md'), '# app\nTWO\n');
  const h = hook(alice, projectDir(alice, 'app'));
  assert.equal(h.status, 0);
  assert.match(h.stdout, /WARNING: Project app has notes in more than one team \(one, two\)/);
  assert.ok(!h.stdout.includes('shared in team'));
  assert.equal(pctx(alice, ['session-path', '--project', 'app']).status, 1);
});

test('sync blocks a secret in a team repo and exits 2', () => {
  const { team, alice } = twoPeople();
  teamAdd(alice, 'studio', team);
  const before = remoteFilesOf(team).length;
  write(path.join(alice.pctxHome, 'teams', 'studio', 'projects', 'x.md'), `token ${fakeGithubToken()}\n`);
  const s = pctx(alice, ['sync']);
  assert.equal(s.status, 2);
  assert.match(s.stderr, /^team studio: blocked/m);
  assert.ok(!s.stderr.includes(fakeGithubToken()));
  assert.equal(remoteFilesOf(team).length, before);
});

test('an unreachable team repo warns in the hook but still loads the context', () => {
  const { team, alice } = twoPeople();
  teamAdd(alice, 'studio', team);
  fs.renameSync(team, team + '.off');
  const h = hook(alice, projectDir(alice, 'any'));
  assert.equal(h.status, 0);
  assert.match(h.stdout, /WARNING: team studio may be out of date/);
  assert.ok(h.stdout.includes('## Profile'));
});

test('setup again keeps the teams and author; team remove drops a team', () => {
  const { sb, team, alice } = twoPeople();
  teamAdd(alice, 'studio', team);
  setup(alice, sb);
  const cfg = readJson(path.join(alice.pctxHome, 'config.json'));
  assert.equal(cfg.teams.length, 1);
  assert.equal(cfg.author, 'alice');
  assert.match(pctx(alice, ['doctor']).stdout, /Team studio:/);
  assert.equal(pctx(alice, ['team', 'remove', 'studio']).status, 0);
  assert.deepEqual(readJson(path.join(alice.pctxHome, 'config.json')).teams, []);
  assert.ok(fs.existsSync(path.join(alice.pctxHome, 'teams', 'studio')), 'the clone is left in place');
});

test('session-path --private uses the personal repo for a shared project', () => {
  const { team, alice } = twoPeople();
  teamAdd(alice, 'studio', team);
  assert.equal(pctx(alice, ['team', 'share', 'studio', '--project', 'app']).status, 0);
  const r = pctx(alice, ['session-path', '--project', 'app', '--private']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(real(path.dirname(r.stdout.trim())), real(path.join(alice.context, 'sessions')));
  assert.match(path.basename(r.stdout.trim()), /-app-alice-laptop\.md$/);
});

test('the save skill covers sharing a project and splitting private notes', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const skill = fs.readFileSync(path.join(a.claude, 'skills', 'save-context', 'SKILL.md'), 'utf8');
  assert.match(skill, /## Share a project/);
  assert.match(skill, /team share <team> --cwd \./);
  assert.match(skill, /session-path --cwd \. --private/);
  assert.match(skill, /^description: .*share the project with a team/m);
});

test('team add refuses a different URL for an existing team name', () => {
  const { sb, team, alice } = twoPeople();
  teamAdd(alice, 'studio', team);
  const r = pctx(alice, ['team', 'add', 'studio', makeRemote(sb, 'other')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already points at/);
});
