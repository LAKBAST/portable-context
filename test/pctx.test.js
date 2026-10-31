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

function makeDevice(sandbox, name, { claude = true, codex = true } = {}) {
  const home = path.join(sandbox.root, name, 'home');
  const d = {
    name,
    home,
    pctxHome: path.join(sandbox.root, name, 'pctx'),
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    work: path.join(sandbox.root, name, 'work'),
  };
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(d.work, { recursive: true });
  if (claude) fs.mkdirSync(d.claude, { recursive: true });
  if (codex) fs.mkdirSync(d.codex, { recursive: true });
  d.context = path.join(d.pctxHome, 'context');
  d.env = {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    PCTX_HOME: d.pctxHome,
    CLAUDE_CONFIG_DIR: d.claude,
    CODEX_HOME: d.codex,
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
