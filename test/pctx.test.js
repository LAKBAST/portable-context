import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext } from '../src/context.js';

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
  assert.ok(skill.includes('## Working style'), 'the save skill records how the user works');
  assert.ok(skill.includes('never in the team repo'), 'working style stays private for shared projects');
  assert.ok(skill.includes('Change the profile only if they agree'), 'profile changes need the user');
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

test('setup installs a Codex rule that allows exactly pctx sync', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const rules = fs.readFileSync(path.join(a.codex, 'rules', 'pctx.rules'), 'utf8');
  assert.match(rules, /managed-by: portable-context/);
  assert.match(rules, /decision = "allow"/);
  assert.match(rules, /pattern = \["node", "[^"]*bin\/pctx\.js", "sync"\]/);
  assert.match(pctx(a, ['doctor']).stdout, /codex: hook installed, skill installed, sync rule installed/);
});

test('install refuses a foreign Codex pctx.rules and uninstall keeps it', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const file = path.join(a.codex, 'rules', 'pctx.rules');
  fs.writeFileSync(file, 'prefix_rule(pattern = ["ls"], decision = "allow")\n');
  assert.notEqual(pctx(a, ['install']).status, 0);
  pctx(a, ['uninstall']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'prefix_rule(pattern = ["ls"], decision = "allow")\n');
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
  assert.ok(!fs.existsSync(path.join(a.codex, 'rules')), 'our rule and its empty folder are gone');
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

// ---------------------------------------------------------------- remote identity & team isolation

function makeProjectRepo(device, folderName, originUrl) {
  const dir = path.join(device.work, folderName);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', dir]);
  if (originUrl) git(['-C', dir, 'remote', 'add', 'origin', originUrl]);
  return dir;
}

function updateConfig(device, fn) {
  const file = path.join(device.pctxHome, 'config.json');
  const cfg = readJson(file);
  const next = fn(cfg) ?? cfg;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

test('two hosts and a personal repo with the same basename stay completely separate', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const partnerRemote = makeRemote(sb, 'partner-team');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);

  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);
  teamAdd(alex, 'partner', partnerRemote, [
    '--isolated',
    '--remote', 'https://git.partner.example/core/api.git',
  ]);

  const personalApi = makeProjectRepo(alex, 'personal-api', 'https://github.com/alex/api.git');
  const acmeApi = makeProjectRepo(alex, 'acme-api', 'https://git.acme.example/platform/api.git');
  const acmeApiSsh = makeProjectRepo(alex, 'acme-api-ssh', 'git@git.acme.example:platform/api.git');
  const acmeNested = makeProjectRepo(alex, 'acme-nested', 'https://git.acme.example/platform/billing/api.git');
  const partnerApi = makeProjectRepo(alex, 'partner-api', 'git@git.partner.example:core/api.git');
  const noRemote = makeProjectRepo(alex, 'api', null);

  // Each repo resolves to a distinct session-path in its own repo.
  const pPers = pctx(alex, ['session-path', '--cwd', personalApi]);
  const pAcme = pctx(alex, ['session-path', '--cwd', acmeApi]);
  const pAcmeSsh = pctx(alex, ['session-path', '--cwd', acmeApiSsh]);
  const pAcmeNested = pctx(alex, ['session-path', '--cwd', acmeNested]);
  const pPartner = pctx(alex, ['session-path', '--cwd', partnerApi]);
  const pNoRemote = pctx(alex, ['session-path', '--cwd', noRemote]);
  for (const r of [pPers, pAcme, pAcmeSsh, pAcmeNested, pPartner, pNoRemote]) {
    assert.equal(r.status, 0, r.stderr);
  }

  const stem = (res) =>
    path.basename(res.stdout.trim())
      .replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '')
      .replace(new RegExp(`-(?:alex-)?${alex.name}\\.md$`), '');
  // HTTPS and SSH of the exact same repo match the exact same project ID.
  assert.equal(stem(pAcme), stem(pAcmeSsh));
  // Personal, nested, partner, and no-remote all have distinct IDs.
  const distinct = new Set([stem(pPers), stem(pAcme), stem(pAcmeNested), stem(pPartner), stem(pNoRemote)]);
  assert.equal(distinct.size, 5);
  assert.match(stem(pNoRemote), /^local--api$/);

  assert.equal(real(path.dirname(pPers.stdout.trim())), real(path.join(alex.context, 'sessions')));
  assert.equal(real(path.dirname(pAcme.stdout.trim())), real(path.join(alex.pctxHome, 'teams', 'acme', 'sessions')));
  assert.equal(real(path.dirname(pPartner.stdout.trim())), real(path.join(alex.pctxHome, 'teams', 'partner', 'sessions')));

  // Write distinct markers in personal and acme and check hooks never mix them.
  write(pPers.stdout.trim(), '# Personal\nPERSONAL-API-MARKER\n');
  write(path.join(alex.context, 'projects', `${stem(pPers)}.md`), 'PERSONAL-PROJ-MARKER\n');
  write(pAcme.stdout.trim(), '# Acme\nACME-API-MARKER\n');
  write(path.join(alex.pctxHome, 'teams', 'acme', 'projects', `${stem(pAcme)}.md`), 'ACME-PROJ-MARKER\n');
  write(path.join(alex.pctxHome, 'teams', 'partner', 'projects', `${stem(pPartner)}.md`), 'PARTNER-PROJ-MARKER\n');

  const hPers = hook(alex, personalApi);
  assert.equal(hPers.status, 0);
  assert.ok(hPers.stdout.includes('PERSONAL-PROJ-MARKER'));
  assert.ok(!hPers.stdout.includes('ACME-PROJ-MARKER'));
  assert.ok(!hPers.stdout.includes('PARTNER-PROJ-MARKER'));
  assert.ok(!hPers.stdout.includes('Team repos:'));

  const hAcme = hook(alex, acmeApiSsh);
  assert.equal(hAcme.status, 0);
  assert.ok(hAcme.stdout.includes('ACME-PROJ-MARKER'));
  assert.ok(!hAcme.stdout.includes('PERSONAL-PROJ-MARKER'));
  assert.ok(!hAcme.stdout.includes('PARTNER-PROJ-MARKER'));
  assert.ok(!hAcme.stdout.includes(alex.context));
});

test('isolated corporate project resolves by remote even without projects/*.md and handles shared vs private storage', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  // Keep personal mode legacy to verify configured team scope still resolves by remote.
  setup(alex, sb, ['--author', 'alex']);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);

  const freshCorp = makeProjectRepo(alex, 'brand-new-svc', 'https://git.acme.example/platform/brand-new-svc.git');
  // No projects/<id>.md exists yet in acme!
  const h = hook(alex, freshCorp);
  assert.equal(h.status, 0);
  assert.ok(h.stdout.includes('# Portable context (team acme)'), h.stdout);
  assert.ok(h.stdout.includes('Remote: git.acme.example/platform/brand-new-svc'), h.stdout);
  assert.ok(h.stdout.includes('No notes yet'), h.stdout);
  assert.ok(!h.stdout.includes(alex.context), 'personal repo must not be shown');

  const sharedPath = pctx(alex, ['session-path', '--cwd', freshCorp]);
  assert.equal(sharedPath.status, 0, sharedPath.stderr);
  assert.equal(real(path.dirname(sharedPath.stdout.trim())), real(path.join(alex.pctxHome, 'teams', 'acme', 'sessions')));

  const privPath = pctx(alex, ['session-path', '--cwd', freshCorp, '--private']);
  assert.equal(privPath.status, 0, privPath.stderr);
  assert.equal(real(path.dirname(privPath.stdout.trim())), real(path.join(alex.pctxHome, 'teams', 'acme-private', 'sessions')));
  assert.ok(!fs.existsSync(path.join(alex.context, 'sessions')), 'personal sessions dir must not be created');
});

test('isolated --private fails with no path when privateDir is missing or invalid', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex']);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
  ]);
  const corp = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');

  // Unconfigured privateDir: fails and prints nothing on stdout.
  const noPriv = pctx(alex, ['session-path', '--cwd', corp, '--private']);
  assert.equal(noPriv.status, 1);
  assert.equal(noPriv.stdout.trim(), '');
  assert.match(noPriv.stderr, /no privateDir configured/);

  // Symlink pointing privateDir at personal contextDir: rejected!
  const linkToPersonal = path.join(alex.pctxHome, 'link-personal');
  fs.symlinkSync(alex.context, linkToPersonal);
  updateConfig(alex, (cfg) => {
    cfg.teams[0].privateDir = linkToPersonal;
  });
  const symPriv = pctx(alex, ['session-path', '--cwd', corp, '--private']);
  assert.equal(symPriv.status, 1);
  assert.equal(symPriv.stdout.trim(), '');
  assert.match(symPriv.stderr, /personal context repo/);

  // Sync also refuses invalid privateDir.
  const badSync = pctx(alex, ['sync', '--cwd', corp]);
  assert.equal(badSync.status, 1);
  assert.match(badSync.stderr, /personal context repo/);

  // Pointing privateDir to a separate clone of the personal remote URL is also rejected!
  const cloneOfPersonal = path.join(alex.pctxHome, 'second-personal-clone');
  git(['clone', '-q', sb.remote, cloneOfPersonal]);
  updateConfig(alex, (cfg) => {
    cfg.teams[0].privateDir = cloneOfPersonal;
  });
  const sameRemotePriv = pctx(alex, ['session-path', '--cwd', corp, '--private']);
  assert.equal(sameRemotePriv.status, 1);
  assert.equal(sameRemotePriv.stdout.trim(), '');
  assert.match(sameRemotePriv.stderr, /personal context repo/);

  // Non-existent / non-git privateDir fails before writing or syncing.
  const missingPriv = path.join(alex.pctxHome, 'does-not-exist');
  updateConfig(alex, (cfg) => {
    cfg.teams[0].privateDir = missingPriv;
  });
  const missRes = pctx(alex, ['session-path', '--cwd', corp, '--private']);
  assert.equal(missRes.status, 1);
  assert.equal(missRes.stdout.trim(), '');
  assert.ok(!fs.existsSync(missingPriv), 'must not create directory for invalid privateDir');
});

test('ambiguous team scope fails safely across hook, session-path, share, scan, and sync', () => {
  const sb = makeSandbox();
  const r1 = makeRemote(sb, 'team-one');
  const r2 = makeRemote(sb, 'team-two');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex']);
  teamAdd(alex, 'one', r1, ['--isolated', '--namespace', 'git.acme.example/org']);
  teamAdd(alex, 'two', r2, ['--isolated', '--remote', 'https://git.acme.example/org/app.git']);
  write(path.join(alex.context, 'AGENTS.md'), 'PERSONAL-PROFILE-SHOULD-NOT-LOAD\n');
  write(path.join(alex.context, 'projects', 'app.md'), 'PERSONAL-SHOULD-NOT-LOAD\n');
  git(['-C', alex.context, 'add', '-A']);
  git(['-C', alex.context, 'commit', '-q', '-m', 'pending personal commit']);
  const personalHeadBefore = remoteHead(sb);

  const ambigRepo = makeProjectRepo(alex, 'app', 'https://git.acme.example/org/app.git');
  const h = hook(alex, ambigRepo);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^Portable context unavailable: Ambiguous team scope/);
  assert.ok(!h.stdout.includes('# Portable context'), 'hook must emit only the error');
  assert.ok(!h.stdout.includes('PERSONAL-PROFILE-SHOULD-NOT-LOAD'));
  assert.ok(!h.stdout.includes('PERSONAL-SHOULD-NOT-LOAD'));
  assert.equal(remoteHead(sb), personalHeadBefore, 'ambiguous isolated conflict must not push personal commit');

  for (const args of [
    ['session-path', '--cwd', ambigRepo],
    ['team', 'share', 'one', '--cwd', ambigRepo],
    ['sync', '--cwd', ambigRepo],
    ['scan', '--cwd', ambigRepo],
  ]) {
    const res = pctx(alex, args);
    assert.equal(res.status, 1, `expected failure for ${args.join(' ')}`);
    assert.match(res.stderr, /Ambiguous team scope/);
  }

  // Collision involving one isolated team and one non-isolated scoped team also blocks personal fallback and push.
  const r3 = makeRemote(sb, 'team-three');
  teamAdd(alex, 'three', r3, ['--namespace', 'git.mixed.example/org']);
  const r4 = makeRemote(sb, 'team-four');
  teamAdd(alex, 'four', r4, ['--isolated', '--remote', 'https://git.mixed.example/org/svc.git']);
  const mixedRepo = makeProjectRepo(alex, 'svc', 'https://git.mixed.example/org/svc.git');
  const hMixed = hook(alex, mixedRepo);
  assert.equal(hMixed.status, 0);
  assert.match(hMixed.stdout, /^Portable context unavailable: Ambiguous team scope/);
  assert.ok(!hMixed.stdout.includes('# Portable context'));
  assert.ok(!hMixed.stdout.includes('PERSONAL-PROFILE-SHOULD-NOT-LOAD'));
  assert.equal(remoteHead(sb), personalHeadBefore, 'mixed isolated collision must not push personal commit');

  // Legacy collision between two non-isolated teams preserves WARNING + personal context behavior.
  const r5 = makeRemote(sb, 'team-five');
  teamAdd(alex, 'five', r5, ['--namespace', 'git.legacy.example/org']);
  const r6 = makeRemote(sb, 'team-six');
  teamAdd(alex, 'six', r6, ['--namespace', 'git.legacy.example/org']);
  const legacyRepo = makeProjectRepo(alex, 'legacy', 'https://git.legacy.example/org/legacy.git');
  const hLegacy = hook(alex, legacyRepo);
  assert.equal(hLegacy.status, 0);
  assert.ok(hLegacy.stdout.includes('# Portable context'));
  assert.match(hLegacy.stdout, /WARNING: Ambiguous team scope/);
});

test('explicit migration aliases load legacy personal notes only for declared remote, never by basename', () => {
  const sb = makeSandbox();
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--project-identity', 'remote']);

  write(path.join(alex.context, 'projects', 'api.md'), '# legacy api\nLEGACY-ALEX-API-NOTES\n');
  write(path.join(alex.context, 'sessions', '2026-01-01-1000-api-alex-laptop.md'), '# old session\n');
  assert.equal(pctx(alex, ['sync']).status, 0);

  updateConfig(alex, (cfg) => {
    cfg.aliases = { api: 'github.com/alex/api' };
  });

  const ownApi = makeProjectRepo(alex, 'alex-api', 'https://github.com/alex/api.git');
  const otherApi = makeProjectRepo(alex, 'other-api', 'https://github.com/other-org/api.git');

  const hOwn = hook(alex, ownApi);
  assert.equal(hOwn.status, 0);
  assert.ok(hOwn.stdout.includes('LEGACY-ALEX-API-NOTES'), hOwn.stdout);
  assert.ok(hOwn.stdout.includes('2026-01-01-1000-api-alex-laptop.md'), hOwn.stdout);

  const hOther = hook(alex, otherApi);
  assert.equal(hOther.status, 0);
  assert.ok(!hOther.stdout.includes('LEGACY-ALEX-API-NOTES'), 'basename must not leak notes to another remote');
  assert.ok(!hOther.stdout.includes('2026-01-01-1000-api-alex-laptop.md'), 'basename must not leak sessions');
});

test('cross-scope --project or foreign cwd cannot divert corporate saves to personal; --team allows explicit maintenance', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);
  const corp = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');

  // Inside corporate cwd, --project with bare name, traversal, or personal remote fails cleanly.
  for (const badProj of ['payments', 'personal-proj', '../escape', 'https://github.com/alex/solo.git']) {
    const r = pctx(alex, ['session-path', '--cwd', corp, '--project', badProj]);
    assert.equal(r.status, 1, `expected failure for --project ${badProj}`);
    assert.equal(r.stdout.trim(), '');
  }

  // From unrelated cwd, bare name or corporate remote without --team fails rather than going to personal.
  for (const args of [
    ['session-path', '--cwd', alex.work, '--project', 'payments'],
    ['session-path', '--cwd', alex.work, '--project', 'https://git.acme.example/platform/payments.git'],
  ]) {
    const r = pctx(alex, args);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), '');
  }

  // Explicit maintenance from unrelated cwd via --team works cleanly and unambiguously.
  const maintTeam = pctx(alex, [
    'session-path', '--cwd', alex.work, '--team', 'acme', '--project', 'git.acme.example/platform/payments',
  ]);
  assert.equal(maintTeam.status, 0, maintTeam.stderr);
  assert.equal(real(path.dirname(maintTeam.stdout.trim())), real(path.join(alex.pctxHome, 'teams', 'acme', 'sessions')));

  const maintPriv = pctx(alex, [
    'session-path', '--cwd', alex.work, '--team', 'acme', '--project', 'git.acme.example/platform/payments', '--private',
  ]);
  assert.equal(maintPriv.status, 0, maintPriv.stderr);
  assert.equal(real(path.dirname(maintPriv.stdout.trim())), real(path.join(alex.pctxHome, 'teams', 'acme-private', 'sessions')));

  const maintSync = pctx(alex, ['sync', '--cwd', alex.work, '--team', 'acme']);
  assert.equal(maintSync.status, 0, maintSync.stderr);
  assert.match(maintSync.stdout, /^team acme: /m);
  assert.match(maintSync.stdout, /^private acme: /m);
  assert.ok(!maintSync.stdout.includes('context:'));
});

test('bidirectional hook and sync with local bare remotes enforce strict personal/corporate isolation', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  const sam = makeDevice(sb, 'sam-pc');

  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  const samPersonalRemote = makeRemote(sb, 'sam-personal');
  assert.equal(pctx(sam, ['setup', samPersonalRemote, '--device', sam.name, '--author', 'sam', '--project-identity', 'remote']).status, 0);

  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);
  teamAdd(sam, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
  ]);

  const personalProj = makeProjectRepo(alex, 'personal-app', 'https://github.com/alex/personal-app.git');
  const corpProj = makeProjectRepo(alex, 'corp-app', 'https://git.acme.example/platform/corp-app.git');

  // Create unpushed commit in acme team repo + marker in acme private repo.
  const acmeSession = pctx(alex, ['session-path', '--cwd', corpProj]);
  assert.equal(acmeSession.status, 0, acmeSession.stderr);
  write(acmeSession.stdout.trim(), '# Corp session\nACME-SHARED-MARKER\n');
  const acmePrivSession = pctx(alex, ['session-path', '--cwd', corpProj, '--private']);
  assert.equal(acmePrivSession.status, 0, acmePrivSession.stderr);
  write(acmePrivSession.stdout.trim(), '# Corp private\nACME-PRIV-MARKER\n');

  // Commit locally in acme without pushing yet to verify personal hook does NOT push acme!
  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');
  git(['-C', acmeDir, 'add', '-A']);
  git(['-C', acmeDir, 'commit', '-q', '-m', 'unpushed acme']);
  const acmeHeadBefore = git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim();

  // Personal hook + sync must only touch personal repo!
  const persSession = pctx(alex, ['session-path', '--cwd', personalProj]);
  assert.equal(persSession.status, 0, persSession.stderr);
  write(persSession.stdout.trim(), '# Personal session\nPERSONAL-MARKER\n');
  const hPersBefore = hook(alex, personalProj);
  assert.equal(hPersBefore.status, 0);
  assert.ok(!hPersBefore.stdout.includes('acme'));
  assert.equal(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore, 'personal hook must not push isolated team');

  const sPers = pctx(alex, ['sync', '--cwd', personalProj]);
  assert.equal(sPers.status, 0, sPers.stderr);
  assert.equal(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore, 'personal sync must not push isolated team');
  assert.ok(remoteFiles(sb).some((f) => f.includes(path.basename(persSession.stdout.trim()))));

  // Uncommitted personal file committed locally without pushing, to verify corporate hook/sync does NOT push personal!
  write(path.join(alex.context, 'projects', 'unpushed-personal.md'), 'UNPUSHED-PERSONAL-MARKER\n');
  git(['-C', alex.context, 'add', '-A']);
  git(['-C', alex.context, 'commit', '-q', '-m', 'unpushed personal']);
  const persHeadBefore = remoteHead(sb);

  // Corporate hook + sync must only load/push acme and acme-private!
  const hCorp = hook(alex, corpProj);
  assert.equal(hCorp.status, 0);
  assert.ok(!hCorp.stdout.includes('PERSONAL-MARKER'));
  assert.ok(!hCorp.stdout.includes('UNPUSHED-PERSONAL-MARKER'));
  assert.equal(remoteHead(sb), persHeadBefore, 'corporate hook must not push personal repo');
  assert.notEqual(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore, 'corporate hook pushes pending acme commit');

  const sCorp = pctx(alex, ['sync', '--cwd', corpProj]);
  assert.equal(sCorp.status, 0, sCorp.stderr);
  assert.match(sCorp.stdout, /^team acme: (?:synced|up-to-date)/m);
  assert.match(sCorp.stdout, /^private acme: synced/m);
  assert.equal(remoteHead(sb), persHeadBefore, 'corporate sync must not push personal repo');

  assert.ok(remoteFilesOf(acmeRemote).includes(`sessions/${path.basename(acmeSession.stdout.trim())}`));
  assert.ok(remoteFilesOf(acmePrivRemote).includes(`sessions/${path.basename(acmePrivSession.stdout.trim())}`));
  assert.ok(!remoteFilesOf(acmeRemote).some((f) => f.includes('personal-app')));

  // Teammate Sam pulls via hook in corpProj and sees ACME-SHARED-MARKER, never ACME-PRIV-MARKER or PERSONAL-MARKER.
  const samCorp = makeProjectRepo(sam, 'corp-app', 'git@git.acme.example:platform/corp-app.git');
  const hSam = hook(sam, samCorp);
  assert.equal(hSam.status, 0);
  assert.ok(hSam.stdout.includes(path.basename(acmeSession.stdout.trim())));
  assert.ok(!hSam.stdout.includes(path.basename(acmePrivSession.stdout.trim())));
  assert.ok(!hSam.stdout.includes('PERSONAL-MARKER'));
});

test('save skill isolates Working style and handles missing private destination; credentials are redacted', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const skill = fs.readFileSync(path.join(a.claude, 'skills', 'save-context', 'SKILL.md'), 'utf8');
  assert.match(skill, /never compare `## Working style` with the personal context repo/i);
  assert.match(skill, /if `--private` fails because no private destination is configured/i);
  assert.match(skill, /Only for a non-isolated \(legacy\) team/i);
  assert.match(skill, /never read or migrate notes from the personal context repo/i);
  assert.match(skill, /--private` \(reusing the same `--project <name>` if you used it in step 1\)/);

  const token = 's3cr3t_team_tok';
  const r = pctx(a, ['team', 'add', 'acme', `https://bot:${token}@git.acme.example/team.git`]);
  assert.equal(r.status, 1);
  assert.ok(!r.stderr.includes(token), 'credential must never appear in stderr');

  teamAdd(a, 'acme', acmeRemote, ['--isolated', '--namespace', 'git.acme.example/platform']);
  const doc = pctx(a, ['doctor']);
  assert.equal(doc.status, 0);
  assert.match(doc.stdout, /Team acme:.*\[isolated/);
});

test('case-distinct remotes and non-default ports stay separate; case-variant of isolated scope never falls back to personal', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'acme', acmeRemote, ['--isolated', '--namespace', 'git.acme.example/platform']);

  write(path.join(alex.context, 'AGENTS.md'), 'PERSONAL-PROFILE-MARKER\n');
  git(['-C', alex.context, 'add', '-A']);
  git(['-C', alex.context, 'commit', '-q', '-m', 'pending personal']);
  const persHeadBefore = remoteHead(sb);

  const portA = makeProjectRepo(alex, 'port-a', 'https://git.custom.example:8443/Team/Api.git');
  const portB = makeProjectRepo(alex, 'port-b', 'https://git.custom.example:9443/Team/Api.git');
  const lowerA = makeProjectRepo(alex, 'lower-a', 'https://git.custom.example:8443/team/api.git');
  const stems = [portA, portB, lowerA].map((dir) => {
    const res = pctx(alex, ['session-path', '--cwd', dir]);
    assert.equal(res.status, 0, res.stderr);
    return path.basename(res.stdout.trim()).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/-alex-laptop\.md$/, '');
  });
  assert.equal(new Set(stems).size, 3, `expected 3 distinct IDs, got ${stems.join(', ')}`);

  // Case-variant of isolated team namespace must not fall back to personal or push personal commits.
  const caseVariant = makeProjectRepo(alex, 'case-var', 'https://git.acme.example/Platform/api.git');
  const h = hook(alex, caseVariant);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^Portable context unavailable:.*differs only in path casing/);
  assert.ok(!h.stdout.includes('PERSONAL-PROFILE-MARKER'));
  assert.equal(remoteHead(sb), persHeadBefore);
  assert.equal(pctx(alex, ['session-path', '--cwd', caseVariant]).status, 1);
  assert.equal(pctx(alex, ['sync', '--cwd', caseVariant]).status, 1);
});

test('isolated push destination validation blocks pushurl/pushRemote leaks and pushes explicitly to origin', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const rogueRemote = makeRemote(sb, 'rogue');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);
  const corp = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');
  const acmePrivDir = path.join(alex.pctxHome, 'teams', 'acme-private');
  const persHeadBefore = remoteHead(sb);

  // 1) Multiple pushurls on privateDir where one is a file:// symlink to the personal bare repo.
  const linkToPersonalRemote = path.join(sb.root, 'personal-link.git');
  fs.symlinkSync(sb.remote, linkToPersonalRemote);
  git(['-C', acmePrivDir, 'config', '--add', 'remote.origin.pushurl', acmePrivRemote]);
  git(['-C', acmePrivDir, 'config', '--add', 'remote.origin.pushurl', `file://${linkToPersonalRemote}`]);

  const blockedPriv = pctx(alex, ['session-path', '--cwd', corp, '--private']);
  assert.equal(blockedPriv.status, 1);
  assert.match(blockedPriv.stderr, /personal context repo/);
  assert.equal(pctx(alex, ['sync', '--cwd', corp]).status, 1);
  assert.equal(remoteHead(sb), persHeadBefore);

  // Clean up pushurl and test local remote.pushDefault pointing to personal remote.
  git(['-C', acmePrivDir, 'config', '--unset-all', 'remote.origin.pushurl']);
  git(['-C', acmePrivDir, 'remote', 'add', 'leak', sb.remote]);
  git(['-C', acmePrivDir, 'config', 'remote.pushDefault', 'leak']);
  assert.equal(pctx(alex, ['session-path', '--cwd', corp, '--private']).status, 1);
  assert.equal(pctx(alex, ['sync', '--cwd', corp]).status, 1);
  assert.equal(remoteHead(sb), persHeadBefore);

  // 2) With remote.pushDefault & branch.main.pushRemote pointing to a third bare repo (rogue),
  // isolated sync and hook still push ONLY to origin (acmePrivRemote), leaving rogue and personal untouched.
  git(['-C', acmePrivDir, 'remote', 'set-url', 'leak', rogueRemote]);
  git(['-C', acmePrivDir, 'config', 'branch.main.pushRemote', 'leak']);
  const rogueHeadBefore = git(['--git-dir', rogueRemote, 'rev-parse', 'main'], { allowFail: true });
  assert.notEqual(rogueHeadBefore.status, 0, 'rogue bare repo starts empty');

  const privSession = pctx(alex, ['session-path', '--cwd', corp, '--private']);
  assert.equal(privSession.status, 0, privSession.stderr);
  write(privSession.stdout.trim(), '# Private\nISOLATED-ONLY-ORIGIN\n');
  const s = pctx(alex, ['sync', '--cwd', corp]);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /^private acme: synced/m);
  assert.ok(remoteFilesOf(acmePrivRemote).includes(`sessions/${path.basename(privSession.stdout.trim())}`));
  assert.equal(remoteHead(sb), persHeadBefore, 'personal bare repo must receive no changes');
  assert.notEqual(git(['--git-dir', rogueRemote, 'rev-parse', 'main'], { allowFail: true }).status, 0, 'rogue bare repo must receive no changes');

  // Pending commit in acmePrivDir pushed via hook also goes only to origin.
  write(path.join(acmePrivDir, 'projects', 'hook-push.md'), 'HOOK-ORIGIN-ONLY\n');
  git(['-C', acmePrivDir, 'add', '-A']);
  git(['-C', acmePrivDir, 'commit', '-q', '-m', 'pending priv']);
  const h = hook(alex, corp);
  assert.equal(h.status, 0);
  assert.ok(remoteFilesOf(acmePrivRemote).includes('projects/hook-push.md'));
  assert.equal(remoteHead(sb), persHeadBefore);
  assert.notEqual(git(['--git-dir', rogueRemote, 'rev-parse', 'main'], { allowFail: true }).status, 0);
});

// ---------------------------------------------------------------- configurable personal data scanning

test('migration without opt-in keeps personal data unblocked while GOCSPX- is blocked globally', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);

  const syntheticDni = '00000001R';
  const syntheticIban = 'ES8200000000000000000000';
  write(
    path.join(a.context, 'projects', 'notes.md'),
    `Synthetic samples: ${syntheticDni} ${syntheticIban} +34 600 000 000\n`,
  );
  assert.equal(pctx(a, ['scan']).status, 0);
  const okSync = pctx(a, ['sync']);
  assert.equal(okSync.status, 0, okSync.stderr);
  assert.match(okSync.stdout, /synced/);

  const oauthSecret = 'GOCSPX-' + 'aB3dE5gH7j'.repeat(3).slice(0, 28);
  const headBefore = localHead(a);
  const remoteBefore = remoteHead(sb);
  write(path.join(a.context, 'projects', 'oauth.md'), `client_secret=${oauthSecret}\n`);
  const blockedScan = pctx(a, ['scan']);
  assert.equal(blockedScan.status, 2);
  assert.match(blockedScan.stdout, /oauth\.md:1 \(google-oauth-secret\)/);
  assert.ok(!blockedScan.stdout.includes(oauthSecret));

  const blockedSync = pctx(a, ['sync']);
  assert.equal(blockedSync.status, 2);
  assert.match(blockedSync.stderr, /oauth\.md:1 \(google-oauth-secret\)/);
  assert.ok(!blockedSync.stderr.includes(oauthSecret));
  assert.equal(localHead(a), headBefore);
  assert.equal(remoteHead(sb), remoteBefore);
});

test('per-repo scanRules and privateScanRules block independently across personal, team, and isolated private repos', () => {
  const sb = makeSandbox();
  const studioRemote = makeRemote(sb, 'studio-team');
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'studio', studioRemote);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);

  updateConfig(alex, (cfg) => {
    cfg.scanRules = ['es-dni'];
    cfg.teams.find((t) => t.name === 'studio').scanRules = ['es-iban'];
    const acme = cfg.teams.find((t) => t.name === 'acme');
    acme.scanRules = ['es-pii'];
    acme.privateScanRules = ['es-mobile'];
  });

  const doc = pctx(alex, ['doctor']);
  assert.equal(doc.status, 0);
  assert.match(doc.stdout, /Scan rules \(context\): es-dni/);
  assert.match(doc.stdout, /Team acme scan rules: es-pii/);
  assert.match(doc.stdout, /Team acme private scan rules: es-mobile/);

  const studioDir = path.join(alex.pctxHome, 'teams', 'studio');
  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');
  const acmePrivDir = path.join(alex.pctxHome, 'teams', 'acme-private');
  const corpRepo = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');

  const dni = '00000001R';
  const iban = 'ES55 0000 0000 0000 0000 0001';
  const mobile = '+34 600 000 000';

  // 1) Personal + non-isolated scope: personal blocks DNI (allows IBAN), studio blocks IBAN (allows DNI).
  write(path.join(alex.context, 'projects', 'personal-ok.md'), `IBAN allowed here: ${iban}\n`);
  write(path.join(alex.context, 'projects', 'personal-dni.md'), `line1\nDNI: ${dni}\n`);
  write(path.join(studioDir, 'projects', 'studio-dni-ok.md'), `DNI allowed in studio: ${dni}\n`);
  write(path.join(studioDir, 'projects', 'studio-iban.md'), `IBAN blocked in studio: ${iban}\n`);

  const persHeadBefore = remoteHead(sb);
  const studioHeadBefore = git(['--git-dir', studioRemote, 'rev-parse', 'main']).stdout.trim();
  const scanPers = pctx(alex, ['scan', '--cwd', alex.work]);
  assert.equal(scanPers.status, 2);
  assert.match(scanPers.stdout, /^context: projects\/personal-dni\.md:2 \(es-dni\)$/m);
  assert.match(scanPers.stdout, /^team studio: projects\/studio-iban\.md:1 \(es-iban\)$/m);
  assert.ok(!scanPers.stdout.includes(dni) && !scanPers.stdout.includes(iban));

  const syncBlocked = pctx(alex, ['sync', '--cwd', alex.work]);
  assert.equal(syncBlocked.status, 2);
  assert.match(syncBlocked.stderr, /^context: blocked: possible secrets or personal data found/m);
  assert.match(syncBlocked.stderr, /projects\/personal-dni\.md:2 \(es-dni\)/);
  assert.match(syncBlocked.stderr, /^team studio: blocked: possible secrets or personal data found/m);
  assert.match(syncBlocked.stderr, /projects\/studio-iban\.md:1 \(es-iban\)/);
  assert.ok(!syncBlocked.stderr.includes(dni) && !syncBlocked.stderr.includes(iban));
  assert.equal(remoteHead(sb), persHeadBefore, 'blocked personal repo must not push');
  assert.equal(git(['--git-dir', studioRemote, 'rev-parse', 'main']).stdout.trim(), studioHeadBefore, 'blocked studio repo must not push');

  // Remove only studio's IBAN -> studio syncs while personal remains blocked!
  fs.rmSync(path.join(studioDir, 'projects', 'studio-iban.md'));
  const partialSync = pctx(alex, ['sync', '--cwd', alex.work]);
  assert.equal(partialSync.status, 2);
  assert.match(partialSync.stderr, /^context: blocked/m);
  assert.match(partialSync.stdout, /^team studio: synced/m);
  assert.equal(remoteHead(sb), persHeadBefore, 'blocked personal repo still must not push');
  assert.ok(remoteFilesOf(studioRemote).includes('projects/studio-dni-ok.md'));

  // Clean personal DNI -> personal syncs with IBAN intact.
  fs.rmSync(path.join(alex.context, 'projects', 'personal-dni.md'));
  assert.equal(pctx(alex, ['sync', '--cwd', alex.work]).status, 0);
  assert.ok(remoteFiles(sb).includes('projects/personal-ok.md'));

  // 2) Isolated team scope: acme shared blocks es-pii, while acme private blocks only es-mobile.
  const acmeHeadBefore = git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim();
  const acmePrivHeadBefore = git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim();
  write(path.join(acmeDir, 'projects', 'corp-leak.md'), `NIE X0000000T\n`);
  write(path.join(acmePrivDir, 'projects', 'priv-ok.md'), `DNI ${dni} and IBAN ${iban}\n`);

  const corpSync = pctx(alex, ['sync', '--cwd', corpRepo]);
  assert.equal(corpSync.status, 2);
  assert.match(corpSync.stderr, /^team acme: blocked.*corp-leak\.md:1 \(es-nie\)/ms);
  assert.match(corpSync.stdout, /^private acme: synced/m);
  assert.equal(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore);
  assert.notEqual(git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim(), acmePrivHeadBefore);

  // Now test es-mobile + GOCSPX- together in acme private repo.
  const oauthSecret = 'GOCSPX-' + 'x9K2mP4qR6'.repeat(3).slice(0, 28);
  const privHead2 = git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim();
  write(path.join(acmePrivDir, 'projects', 'priv-both.md'), `secret=${oauthSecret}\ntel=${mobile}\n`);
  const corpScan = pctx(alex, ['scan', '--cwd', corpRepo]);
  assert.equal(corpScan.status, 2);
  assert.match(corpScan.stdout, /^private acme: projects\/priv-both\.md:1 \(google-oauth-secret\)$/m);
  assert.match(corpScan.stdout, /^private acme: projects\/priv-both\.md:2 \(es-mobile\)$/m);
  assert.ok(!corpScan.stdout.includes(oauthSecret) && !corpScan.stdout.includes(mobile));

  const corpSync2 = pctx(alex, ['sync', '--cwd', corpRepo]);
  assert.equal(corpSync2.status, 2);
  assert.match(corpSync2.stderr, /projects\/priv-both\.md:1 \(google-oauth-secret\)/);
  assert.match(corpSync2.stderr, /projects\/priv-both\.md:2 \(es-mobile\)/);
  assert.equal(git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim(), privHead2);
});

test('invalid scanRules or privateScanRules fail before any commit or push runs', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  setup(a, sb);
  const headBefore = localHead(a);
  const remoteBefore = remoteHead(sb);
  write(path.join(a.context, 'projects', 'pending.md'), 'pending content\n');

  for (const badRules of [['nonexistent-rule'], 'es-pii', [123]]) {
    updateConfig(a, (cfg) => {
      cfg.scanRules = badRules;
    });
    const scanRes = pctx(a, ['scan']);
    assert.equal(scanRes.status, 1);
    assert.match(scanRes.stderr, /scanRules/);

    const syncRes = pctx(a, ['sync']);
    assert.equal(syncRes.status, 1);
    assert.match(syncRes.stderr, /scanRules/);
    assert.equal(localHead(a), headBefore, 'invalid config must prevent commit');
    assert.equal(remoteHead(sb), remoteBefore, 'invalid config must prevent push');
  }
});

// ---------------------------------------------------------------- decisions index & autoload

test('hook indexes decisions in current scope without leaking other teams or loading other bodies', () => {
  const sb = makeSandbox();
  const studioRemote = makeRemote(sb, 'studio-team');
  const otherTeamRemote = makeRemote(sb, 'other-team');
  const isolatedRemote = makeRemote(sb, 'isolated-team');
  const alex = makeDevice(sb, 'alex-laptop', { antigravity: true });
  setup(alex, sb, ['--author', 'alex']);
  teamAdd(alex, 'studio', studioRemote);
  teamAdd(alex, 'other', otherTeamRemote);
  teamAdd(alex, 'corp', isolatedRemote, ['--isolated', '--namespace', 'git.corp.example/org']);

  const studioDir = path.join(alex.pctxHome, 'teams', 'studio');
  const otherDir = path.join(alex.pctxHome, 'teams', 'other');
  const corpDir = path.join(alex.pctxHome, 'teams', 'corp');

  assert.equal(pctx(alex, ['team', 'share', 'studio', '--project', 'alpha']).status, 0);
  write(path.join(alex.context, 'decisions', 'alpha.md'), 'PERSONAL-ALPHA-DECISION-BODY\n');
  write(path.join(alex.context, 'decisions', 'adr-001.md'), 'SECRET-OTHER-DECISION-BODY\n');
  write(path.join(alex.context, 'decisions', 'alpha-notes.md'), 'PREFIX-NOT-AUTOLOADED\n');
  write(path.join(alex.context, 'decisions', 'ignore.txt'), 'not markdown\n');
  fs.mkdirSync(path.join(alex.context, 'decisions', 'dir.md'), { recursive: true });

  write(path.join(studioDir, 'decisions', 'alpha.md'), 'STUDIO-ALPHA-DECISION-BODY\n');
  write(path.join(studioDir, 'decisions', 'team-arch.md'), 'TEAM-ARCH-BODY-DO-NOT-LOAD\n');

  write(path.join(otherDir, 'decisions', 'other-only.md'), 'OTHER-TEAM-DECISION\n');
  write(path.join(corpDir, 'decisions', 'corp-only.md'), 'CORP-ISOLATED-DECISION\n');

  const alphaRepo = projectDir(alex, 'alpha');
  const h = hook(alex, alphaRepo);
  assert.equal(h.status, 0, h.stderr);
  const out = h.stdout;

  // Current project decision autoloaded per repo without mixing sections.
  assert.ok(out.includes('## Team studio decisions for alpha'), out);
  assert.ok(out.includes('STUDIO-ALPHA-DECISION-BODY'));
  assert.ok(out.includes('## Your private decisions for alpha'), out);
  assert.ok(out.includes('PERSONAL-ALPHA-DECISION-BODY'));

  // Other decision bodies must NOT load, while their names + native paths appear in the index.
  assert.ok(!out.includes('SECRET-OTHER-DECISION-BODY'));
  assert.ok(!out.includes('PREFIX-NOT-AUTOLOADED'));
  assert.ok(!out.includes('TEAM-ARCH-BODY-DO-NOT-LOAD'));
  assert.ok(!out.includes('other-only.md'));
  assert.ok(!out.includes('corp-only.md'));

  assert.ok(out.includes('## Decisions'), out);
  assert.ok(out.includes(`- adr-001.md (personal: ${path.join(alex.context, 'decisions', 'adr-001.md')})`), out);
  assert.ok(out.includes(`- alpha-notes.md (personal: ${path.join(alex.context, 'decisions', 'alpha-notes.md')})`), out);
  assert.ok(out.includes(`- team-arch.md (team studio: ${path.join(studioDir, 'decisions', 'team-arch.md')})`), out);
  assert.ok(!out.includes('ignore.txt'));
  assert.ok(!out.includes('dir.md'));

  // Antigravity format receives the same decisions index and autoloaded decision.
  const ag = pctx(alex, ['hook', '--format', 'antigravity'], {
    input: JSON.stringify({ workspacePaths: [alphaRepo] }),
    cwd: alex.plugin,
  });
  assert.equal(ag.status, 0);
  const agText = JSON.parse(ag.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.ok(agText.includes('## Decisions'));
  assert.ok(agText.includes('STUDIO-ALPHA-DECISION-BODY'));
});

test('isolated team decisions index and autoload include shared and available private without personal leakage', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);

  const corpRepo = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');
  const sess = pctx(alex, ['session-path', '--cwd', corpRepo]);
  assert.equal(sess.status, 0);
  const projectId = path.basename(sess.stdout.trim()).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/-alex-alex-laptop\.md$/, '');

  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');
  const acmePrivDir = path.join(alex.pctxHome, 'teams', 'acme-private');

  write(path.join(alex.context, 'decisions', `${projectId}.md`), 'PERSONAL-DECISION-MUST-NOT-LEAK\n');
  write(path.join(alex.context, 'decisions', 'personal-only.md'), 'PERSONAL-ONLY\n');
  write(path.join(acmeDir, 'decisions', `${projectId}.md`), 'ACME-SHARED-DECISION\n');
  write(path.join(acmeDir, 'decisions', 'shared-rfc.md'), 'SHARED-RFC-BODY\n');
  write(path.join(acmePrivDir, 'decisions', `${projectId}.md`), 'ACME-PRIV-DECISION\n');
  write(path.join(acmePrivDir, 'decisions', 'priv-note.md'), 'PRIV-NOTE-BODY\n');

  const h = hook(alex, corpRepo);
  assert.equal(h.status, 0, h.stderr);
  const out = h.stdout;
  assert.ok(out.includes(`## Team acme decisions for ${projectId}`), out);
  assert.ok(out.includes('ACME-SHARED-DECISION'));
  assert.ok(out.includes(`## Your private decisions for ${projectId}`), out);
  assert.ok(out.includes('ACME-PRIV-DECISION'));
  assert.ok(out.includes(`- shared-rfc.md (team acme: ${path.join(acmeDir, 'decisions', 'shared-rfc.md')})`), out);
  assert.ok(out.includes(`- priv-note.md (private acme: ${path.join(acmePrivDir, 'decisions', 'priv-note.md')})`), out);
  assert.ok(!out.includes('SHARED-RFC-BODY'));
  assert.ok(!out.includes('PRIV-NOTE-BODY'));
  assert.ok(!out.includes('PERSONAL-DECISION-MUST-NOT-LEAK'));
  assert.ok(!out.includes('personal-only.md'));

  // When privateDir becomes unusable, shared decisions still load and private decisions are skipped.
  fs.rmSync(acmePrivDir, { recursive: true, force: true });
  const hNoPriv = hook(alex, corpRepo);
  assert.equal(hNoPriv.status, 0);
  assert.ok(hNoPriv.stdout.includes('ACME-SHARED-DECISION'));
  assert.ok(!hNoPriv.stdout.includes('ACME-PRIV-DECISION'));
  assert.ok(!hNoPriv.stdout.includes('priv-note.md'));
});

test('explicit migration aliases autoload decisions/<alias>.md only for declared remote, never by short basename', () => {
  const sb = makeSandbox();
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--project-identity', 'remote']);

  write(path.join(alex.context, 'decisions', 'api.md'), 'LEGACY-API-DECISION-BODY\n');
  assert.equal(pctx(alex, ['sync']).status, 0);

  updateConfig(alex, (cfg) => {
    cfg.aliases = { api: 'github.com/alex/api' };
  });

  const ownApi = makeProjectRepo(alex, 'alex-api', 'https://github.com/alex/api.git');
  const otherApi = makeProjectRepo(alex, 'other-api', 'https://github.com/other-org/api.git');

  const hOwn = hook(alex, ownApi);
  assert.equal(hOwn.status, 0);
  assert.ok(hOwn.stdout.includes('LEGACY-API-DECISION-BODY'), hOwn.stdout);
  assert.ok(hOwn.stdout.includes('Loaded from declared alias'), hOwn.stdout);

  const hOther = hook(alex, otherApi);
  assert.equal(hOther.status, 0);
  assert.ok(!hOther.stdout.includes('LEGACY-API-DECISION-BODY'), 'ambiguous short basename must not autoload decision');
  assert.ok(hOther.stdout.includes(`- api.md (personal: ${path.join(alex.context, 'decisions', 'api.md')})`), hOther.stdout);
});

test('team aliases do not load personal decisions or count unrelated personal saves', () => {
  const sb = makeSandbox();
  const studioRemote = makeRemote(sb, 'studio-team');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--project-identity', 'remote']);
  teamAdd(alex, 'studio', studioRemote);
  const studioDir = path.join(alex.pctxHome, 'teams', 'studio');
  const project = makeProjectRepo(alex, 'studio-api', 'https://github.com/studio/api.git');

  updateConfig(alex, (cfg) => {
    cfg.aliases = { api: 'github.com/alex/api' };
    cfg.teams[0].remotes = ['github.com/studio/api'];
    cfg.teams[0].aliases = { api: 'github.com/studio/api' };
  });
  write(path.join(alex.context, 'decisions', 'api.md'), 'UNRELATED-PERSONAL-DECISION\n');
  write(path.join(studioDir, 'decisions', 'api.md'), 'TEAM-ALIAS-DECISION\n');
  write(path.join(alex.context, 'sessions', '2002-01-01-0900-api-laptop.md'), 'unrelated\n');
  write(path.join(studioDir, 'sessions', '2001-01-01-0900-api-colleague.md'), 'team session\n');

  const result = hook(alex, project);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TEAM-ALIAS-DECISION/);
  assert.doesNotMatch(result.stdout, /UNRELATED-PERSONAL-DECISION|2002-01-01/);
  assert.match(result.stdout, /REMINDER: [^\n]+2001-01-01/);
});

test('decisions index enforces stable ordering and budget bounds across many files', () => {
  const sb = makeSandbox();
  const studioRemote = makeRemote(sb, 'studio-team');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex']);
  teamAdd(alex, 'studio', studioRemote);

  assert.equal(pctx(alex, ['team', 'share', 'studio', '--project', 'alpha']).status, 0);
  for (let i = 1; i <= 30; i++) {
    const id = String(i).padStart(2, '0');
    write(path.join(alex.context, 'decisions', `p-${id}-decision.md`), `body ${id}\n`);
  }
  const studioDir = path.join(alex.pctxHome, 'teams', 'studio');
  write(path.join(studioDir, 'decisions', 'team-01.md'), 'team 1\n');
  write(path.join(studioDir, 'decisions', 'team-02.md'), 'team 2\n');

  const alphaRepo = projectDir(alex, 'alpha');
  const h1 = hook(alex, alphaRepo);
  const h2 = hook(alex, alphaRepo);
  assert.equal(h1.status, 0);
  assert.equal(h1.stdout, h2.stdout, 'decisions index order must be deterministic across runs');

  const section = h1.stdout.split('## Decisions\n\n')[1].split('\n\n## ')[0];
  assert.ok(section.includes('team-01.md'), 'round-robin should prevent personal repo from starving team repo');
  assert.match(section, /\.\.\. \(\d+ more; browse /);
  const bulletLines = section.split('\n').filter((l) => !l.startsWith('- ... ('));
  assert.ok(bulletLines.length <= 20, `expected <= 20 entries, got ${bulletLines.length}`);
  assert.ok(bulletLines.join('\n').length <= 1500, 'index entries must stay within character budget');
});

test('decisions never follow symlinks escaping the repository, including a symlinked decisions directory', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'acme', acmeRemote, ['--isolated', '--namespace', 'git.acme.example/platform']);

  const corpRepo = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');
  const sess = pctx(alex, ['session-path', '--cwd', corpRepo]);
  const projectId = path.basename(sess.stdout.trim()).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/-alex-alex-laptop\.md$/, '');
  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');

  write(path.join(alex.context, 'decisions', `${projectId}.md`), 'ESCAPED-PERSONAL-DECISION\n');
  write(path.join(alex.context, 'decisions', 'secret-adr.md'), 'ESCAPED-ADR\n');

  // 1) Whole decisions/ directory symlinked (or junctioned on Windows) to personal repo's decisions/.
  fs.symlinkSync(
    path.join(alex.context, 'decisions'),
    path.join(acmeDir, 'decisions'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const hDirLink = hook(alex, corpRepo);
  assert.equal(hDirLink.status, 0);
  assert.ok(!hDirLink.stdout.includes('ESCAPED-PERSONAL-DECISION'));
  assert.ok(!hDirLink.stdout.includes('secret-adr.md'));

  // 2) Real decisions/ directory containing symlinked files pointing outside acmeDir.
  fs.rmSync(path.join(acmeDir, 'decisions'), { recursive: true, force: true });
  fs.mkdirSync(path.join(acmeDir, 'decisions'), { recursive: true });
  write(path.join(acmeDir, 'decisions', 'valid-in-repo.md'), 'VALID-BODY\n');
  let createdFileLinks = true;
  try {
    fs.symlinkSync(path.join(alex.context, 'decisions', `${projectId}.md`), path.join(acmeDir, 'decisions', `${projectId}.md`));
    fs.symlinkSync(path.join(alex.context, 'decisions', 'secret-adr.md'), path.join(acmeDir, 'decisions', 'secret-adr.md'));
  } catch (err) {
    if (process.platform === 'win32' && err.code === 'EPERM') createdFileLinks = false;
    else throw err;
  }

  const hFileLink = hook(alex, corpRepo);
  assert.equal(hFileLink.status, 0);
  if (createdFileLinks) {
    assert.ok(!hFileLink.stdout.includes('ESCAPED-PERSONAL-DECISION'));
    assert.ok(!hFileLink.stdout.includes('secret-adr.md'));
  }
  assert.ok(hFileLink.stdout.includes('valid-in-repo.md'));
  assert.ok(!hFileLink.stdout.includes('VALID-BODY'));
});

// ---------------------------------------------------------------- configurable per-file limits

test('default and configured per-file limits truncate profile, project notes, and decisions while preserving links', () => {
  const sb = makeSandbox();
  const studioRemote = makeRemote(sb, 'studio-team');
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'studio', studioRemote);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);

  const personalProj = makeProjectRepo(alex, 'personal-app', 'https://github.com/alex/personal-app.git');
  const sessPers = pctx(alex, ['session-path', '--cwd', personalProj]);
  const persId = path.basename(sessPers.stdout.trim()).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(new RegExp(`-${alex.name}\\.md$`), '');

  const profFile = path.join(alex.context, 'AGENTS.md');
  const projFile = path.join(alex.context, 'projects', `${persId}.md`);
  const decFile = path.join(alex.context, 'decisions', `${persId}.md`);
  write(profFile, 'P'.repeat(3050));
  write(projFile, 'N'.repeat(4050));
  write(decFile, 'D'.repeat(1550));

  // Default limits: 3000 / 4000 / 1500.
  const hDefault = hook(alex, personalProj);
  assert.equal(hDefault.status, 0);
  assert.ok(hDefault.stdout.includes('P'.repeat(3000)));
  assert.ok(!hDefault.stdout.includes('P'.repeat(3001)));
  assert.ok(hDefault.stdout.includes(`[Truncated. Full file: ${profFile}]`));
  assert.ok(hDefault.stdout.includes('N'.repeat(4000)));
  assert.ok(!hDefault.stdout.includes('N'.repeat(4001)));
  assert.ok(hDefault.stdout.includes(`[Truncated. Full file: ${projFile}]`));
  assert.ok(hDefault.stdout.includes('D'.repeat(1500)));
  assert.ok(!hDefault.stdout.includes('D'.repeat(1501)));
  assert.ok(hDefault.stdout.includes(`[Truncated. Full file: ${decFile}]`));

  // Custom limits apply to personal, non-isolated team, and isolated team + private profiles/notes/decisions.
  updateConfig(alex, (cfg) => {
    cfg.limits = { profile: 20, project: 30, decision: 10 };
  });

  const hCustom = hook(alex, personalProj);
  assert.equal(hCustom.status, 0);
  assert.ok(hCustom.stdout.includes('P'.repeat(20)));
  assert.ok(!hCustom.stdout.includes('P'.repeat(21)));
  assert.ok(hCustom.stdout.includes(`[Truncated. Full file: ${profFile}]`));
  assert.ok(hCustom.stdout.includes('N'.repeat(30)));
  assert.ok(!hCustom.stdout.includes('N'.repeat(31)));
  assert.ok(hCustom.stdout.includes(`[Truncated. Full file: ${projFile}]`));
  assert.ok(hCustom.stdout.includes('D'.repeat(10)));
  assert.ok(!hCustom.stdout.includes('D'.repeat(11)));
  assert.ok(hCustom.stdout.includes(`[Truncated. Full file: ${decFile}]`));

  const corpRepo = makeProjectRepo(alex, 'corp-app', 'https://git.acme.example/platform/corp-app.git');
  const sessCorp = pctx(alex, ['session-path', '--cwd', corpRepo]);
  const corpId = path.basename(sessCorp.stdout.trim()).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(new RegExp(`-(?:alex-)?${alex.name}\\.md$`), '');
  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');
  const acmePrivDir = path.join(alex.pctxHome, 'teams', 'acme-private');
  const teamProfFile = path.join(acmeDir, 'AGENTS.md');
  const privProfFile = path.join(acmePrivDir, 'AGENTS.md');
  const teamProjFile = path.join(acmeDir, 'projects', `${corpId}.md`);
  const privDecFile = path.join(acmePrivDir, 'decisions', `${corpId}.md`);
  write(teamProfFile, 'T'.repeat(50));
  write(privProfFile, 'V'.repeat(50));
  write(teamProjFile, 'C'.repeat(50));
  write(privDecFile, 'X'.repeat(50));

  const hCorp = hook(alex, corpRepo);
  assert.equal(hCorp.status, 0);
  assert.ok(hCorp.stdout.includes('T'.repeat(20)) && !hCorp.stdout.includes('T'.repeat(21)));
  assert.ok(hCorp.stdout.includes(`[Truncated. Full file: ${teamProfFile}]`));
  assert.ok(hCorp.stdout.includes('V'.repeat(20)) && !hCorp.stdout.includes('V'.repeat(21)));
  assert.ok(hCorp.stdout.includes(`[Truncated. Full file: ${privProfFile}]`));
  assert.ok(hCorp.stdout.includes('C'.repeat(30)) && !hCorp.stdout.includes('C'.repeat(31)));
  assert.ok(hCorp.stdout.includes(`[Truncated. Full file: ${teamProjFile}]`));
  assert.ok(hCorp.stdout.includes('X'.repeat(10)) && !hCorp.stdout.includes('X'.repeat(11)));
  assert.ok(hCorp.stdout.includes(`[Truncated. Full file: ${privDecFile}]`));

  // Invalid limits fail cleanly in doctor/sync and emit clear message in hook while exiting 0.
  updateConfig(alex, (cfg) => {
    cfg.limits = { decision: 0 };
  });
  const doc = pctx(alex, ['doctor']);
  assert.equal(doc.status, 0);
  assert.match(doc.stdout, /Config problem: Invalid limits\.decision/);
  const syncRes = pctx(alex, ['sync', '--cwd', personalProj]);
  assert.equal(syncRes.status, 1);
  assert.match(syncRes.stderr, /Invalid limits\.decision/);
  const hBad = hook(alex, personalProj);
  assert.equal(hBad.status, 0);
  assert.match(hBad.stdout, /^Portable context unavailable: Invalid limits\.decision/);

  // Codex additionalContextLimit integration rule stays unchanged at 9000.
  assert.equal(readJson(path.join(alex.codex, 'hooks.json')).hooks.SessionStart[0].hooks[0].additionalContextLimit, 9000);
});

// ---------------------------------------------------------------- stale-save reminder

test('stale-save reminder checks calendar days across visible stores, ignores invalid/future dates, and respects threshold 0', () => {
  const sb = makeSandbox();
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);

  const persRepo = makeProjectRepo(alex, 'solo', 'https://github.com/alex/solo.git');
  const corpRepo = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');
  const persSess = pctx(alex, ['session-path', '--cwd', persRepo]).stdout.trim();
  const persId = path.basename(persSess).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(new RegExp(`-${alex.name}\\.md$`), '');
  const corpSess = pctx(alex, ['session-path', '--cwd', corpRepo]).stdout.trim();
  const corpId = path.basename(corpSess).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(new RegExp(`-(?:alex-)?${alex.name}\\.md$`), '');

  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');
  const acmePrivDir = path.join(alex.pctxHome, 'teams', 'acme-private');
  const cfg = () => readJson(path.join(alex.pctxHome, 'config.json'));

  // 1) No saved sessions yet -> no reminder and no failure-like warning.
  const hEmpty = hook(alex, persRepo);
  assert.equal(hEmpty.status, 0);
  assert.ok(!hEmpty.stdout.includes('REMINDER:'));
  assert.ok(!hEmpty.stdout.includes('WARNING:'));

  // 2) Exact calendar-day boundary with reproducible `now` (2026-11-23):
  //    6 days ago (2026-11-17) -> no reminder; 7 days ago (2026-11-16) -> reminder fires.
  const now = new Date(2026, 10, 23, 8, 15);
  write(path.join(alex.context, 'sessions', `2026-11-16-2350-${persId}-${alex.name}.md`), '# 7 days ago\n');
  // Malformed dates, non-standard names, and future dates must be ignored and never silence the reminder!
  write(path.join(alex.context, 'sessions', `2026-02-30-1000-${persId}-${alex.name}.md`), '# invalid feb 30\n');
  write(path.join(alex.context, 'sessions', `2025-02-29-1000-${persId}-${alex.name}.md`), '# invalid non-leap\n');
  write(path.join(alex.context, 'sessions', `2026-13-01-1000-${persId}-${alex.name}.md`), '# invalid month\n');
  write(path.join(alex.context, 'sessions', `2026-11-22-2500-${persId}-${alex.name}.md`), '# invalid hour\n');
  write(path.join(alex.context, 'sessions', `2099-01-01-1000-${persId}-${alex.name}.md`), '# future date\n');
  write(path.join(alex.context, 'sessions', `badname-${persId}.md`), '# non-standard\n');

  const out7 = buildContext(cfg(), persRepo, { ok: true }, {}, { now });
  assert.match(out7, new RegExp(`REMINDER: Latest saved session for ${persId} is from 2026-11-16 \\(7 calendar days ago; threshold: 7 days\\)`));

  // Threshold 0 disables the reminder completely.
  const outDisabled = buildContext({ ...cfg(), staleSaveDays: 0 }, persRepo, { ok: true }, {}, { now });
  assert.ok(!outDisabled.includes('REMINDER:'));

  // CLI hook end-to-end with an old save and threshold 0 in config.json.
  const hCliStale = hook(alex, persRepo);
  assert.equal(hCliStale.status, 0);
  assert.ok(hCliStale.stdout.includes('REMINDER: Latest saved session'));
  assert.ok(!hCliStale.stdout.includes('unsaved'));
  updateConfig(alex, (c) => { c.staleSaveDays = 0; });
  const hCliDisabled = hook(alex, persRepo);
  assert.equal(hCliDisabled.status, 0);
  assert.ok(!hCliDisabled.stdout.includes('REMINDER:'));
  updateConfig(alex, (c) => { delete c.staleSaveDays; });

  // Adding a 6-day-old session silences the default 7-day reminder, while custom threshold 5 triggers it.
  const recentSess = path.join(alex.context, 'sessions', `2026-11-17-2200-${persId}-${alex.name}.md`);
  write(recentSess, '# 6 days ago\n');
  const out6 = buildContext(cfg(), persRepo, { ok: true }, {}, { now });
  assert.ok(!out6.includes('REMINDER:'));
  const outThresh5 = buildContext({ ...cfg(), staleSaveDays: 5 }, persRepo, { ok: true }, {}, { now });
  assert.match(outThresh5, /REMINDER: .*2026-11-17 \(6 calendar days ago; threshold: 5 days\)/);

  // 3) Isolated team + private repo isolation:
  //    Personal saves never silence or trigger isolated team reminders, and isolated private saves count for that team.
  write(path.join(acmeDir, 'sessions', `2026-11-01-1000-${corpId}-alex-${alex.name}.md`), '# old corp\n');
  const corpStale = buildContext(cfg(), corpRepo, { ok: true }, { acme: { ok: true } }, { now, privateResult: { ok: true } });
  assert.match(corpStale, new RegExp(`REMINDER: Latest saved session for ${corpId} is from 2026-11-01 \\(22 calendar days ago; threshold: 7 days\\)`));

  // A recent save in acme-private counts as a visible save for the isolated project.
  write(path.join(acmePrivDir, 'sessions', `2026-11-20-1000-${corpId}-${alex.name}.md`), '# recent priv\n');
  const corpFresh = buildContext(cfg(), corpRepo, { ok: true }, { acme: { ok: true } }, { now, privateResult: { ok: true } });
  assert.ok(!corpFresh.includes('REMINDER:'));

  // Explicit migration alias session counts only for the declared remote, never for another remote with same basename.
  write(path.join(alex.context, 'sessions', `2026-10-01-1000-legacyapi-${alex.name}.md`), '# legacy alias save\n');
  updateConfig(alex, (c) => { c.aliases = { legacyapi: 'github.com/alex/myapi' }; });
  const aliasedRepo = makeProjectRepo(alex, 'alex-myapi', 'https://github.com/alex/myapi.git');
  const otherRepo = makeProjectRepo(alex, 'other-myapi', 'https://github.com/other/myapi.git');
  const outAliased = buildContext(cfg(), aliasedRepo, { ok: true }, {}, { now });
  assert.match(outAliased, /REMINDER: .*2026-10-01/);
  const outOther = buildContext(cfg(), otherRepo, { ok: true }, {}, { now });
  assert.ok(!outOther.includes('REMINDER:'), 'legacy alias save must not leak to another remote with same basename');
});

// ---------------------------------------------------------------- hook refresh interval & compact mode

function hookCacheDir(device) {
  return path.join(device.pctxHome, 'hook-refresh');
}

function hookCacheFiles(device) {
  const dir = hookCacheDir(device);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
}

function hookWithInput(device, payload, extraArgs = []) {
  return pctx(device, ['hook', ...extraArgs], { input: JSON.stringify(payload) });
}

test('hook caches successful refresh per clone, skips within interval, expires without sleeping, and keeps sync manual', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  setup(b, sb);

  const projA = projectDir(a, 'alpha');
  const projB = projectDir(b, 'alpha');

  // 1) Initial startup hook refreshes and writes a minimal cache entry outside the versioned repo.
  const hStart = hookWithInput(a, { cwd: projA, source: 'startup' });
  assert.equal(hStart.status, 0, hStart.stderr);
  assert.doesNotMatch(hStart.stdout, /WARNING:/);
  const filesA = hookCacheFiles(a);
  assert.equal(filesA.length, 1);
  const cacheData = readJson(filesA[0]);
  assert.deepEqual(Object.keys(cacheData), ['refreshedAt']);
  assert.ok(Number.isFinite(cacheData.refreshedAt) && cacheData.refreshedAt <= Date.now());
  const rawCache = fs.readFileSync(filesA[0], 'utf8');
  assert.ok(!rawCache.includes(sb.remote), 'cache must not store remote URLs');

  // 2) Device B pushes a new note; Device A's warm cache skips pull on resume, clear, missing source, and Antigravity.
  write(path.join(b.context, 'projects', 'alpha.md'), '# alpha\nREMOTE-CHANGE-1\n');
  assert.equal(pctx(b, ['sync']).status, 0);

  for (const payload of [
    { cwd: projA, source: 'resume' },
    { cwd: projA, source: 'clear' },
    { cwd: projA },
  ]) {
    const hWarm = hookWithInput(a, payload);
    assert.equal(hWarm.status, 0);
    assert.doesNotMatch(hWarm.stdout, /WARNING:/);
    assert.ok(!hWarm.stdout.includes('REMOTE-CHANGE-1'), `warm cache should skip pull for ${JSON.stringify(payload)}`);
  }

  const hAgWarm = hookWithInput(a, { conversationId: 'c1', workspacePaths: [projA] }, ['--format', 'antigravity']);
  assert.equal(hAgWarm.status, 0);
  const agText = JSON.parse(hAgWarm.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.ok(agText.includes('Current project: alpha'));
  assert.ok(!agText.includes('REMOTE-CHANGE-1'), 'Antigravity warm cache should skip pull');

  // 3) Another clone (Device B) and a second clone directory under the same PCTX_HOME have no cache and refresh immediately.
  const hB = hookWithInput(b, { cwd: projB, source: 'startup' });
  assert.equal(hB.status, 0);
  assert.ok(hB.stdout.includes('REMOTE-CHANGE-1'));

  const altClone = path.join(a.pctxHome, 'context-alt');
  git(['clone', '-q', sb.remote, altClone]);
  // Rewind altClone by 1 commit so we can verify hook pulls into this separate clone.
  git(['-C', altClone, 'reset', '--hard', 'HEAD~1']);
  updateConfig(a, (cfg) => { cfg.contextDir = altClone; });
  const hAlt = hookWithInput(a, { cwd: projA, source: 'startup' });
  assert.equal(hAlt.status, 0);
  assert.ok(hAlt.stdout.includes('REMOTE-CHANGE-1'), 'second clone directory must not reuse first clone cache');
  assert.equal(hookCacheFiles(a).length, 2, 'each clone gets its own cache key');
  updateConfig(a, (cfg) => { cfg.contextDir = a.context; });

  // 4) Manual pctx sync ignores the warm hook cache and pulls immediately.
  const syncRes = pctx(a, ['sync']);
  assert.equal(syncRes.status, 0, syncRes.stderr);
  assert.match(syncRes.stdout, /up-to-date/);
  assert.ok(fs.readFileSync(path.join(a.context, 'projects', 'alpha.md'), 'utf8').includes('REMOTE-CHANGE-1'));

  // 5) Simulated expiration without sleeping triggers a refresh on the next hook.
  write(path.join(b.context, 'projects', 'alpha.md'), '# alpha\nREMOTE-CHANGE-2\n');
  assert.equal(pctx(b, ['sync']).status, 0);
  assert.ok(!hookWithInput(a, { cwd: projA, source: 'resume' }).stdout.includes('REMOTE-CHANGE-2'));

  const expiredAt = Date.now() - 125_000;
  write(filesA[0], `${JSON.stringify({ refreshedAt: expiredAt })}\n`);
  const hExpired = hookWithInput(a, { cwd: projA, source: 'resume' });
  assert.equal(hExpired.status, 0);
  assert.ok(hExpired.stdout.includes('REMOTE-CHANGE-2'), 'expired cache must refresh');
  assert.ok(readJson(filesA[0]).refreshedAt > expiredAt, 'refreshedAt should be updated after refresh');

  // Matcher remains unchanged for Claude Code and Codex.
  assert.equal(readJson(path.join(a.claude, 'settings.json')).hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(readJson(path.join(a.codex, 'hooks.json')).hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
});

test('hook does not cache errors, recovers from corrupt/future/unwritable cache, and never exposes credentials', () => {
  const sb = makeSandbox();
  const a = makeDevice(sb, 'laptop');
  const b = makeDevice(sb, 'desktop');
  setup(a, sb);
  setup(b, sb);

  // 1) Offline pull failure is not cached; next online hook retries immediately.
  offline(sb);
  const hOff = hookWithInput(a, { cwd: a.work, source: 'startup' });
  assert.equal(hOff.status, 0);
  assert.match(hOff.stdout, /WARNING: the context may be out of date/);
  assert.equal(hookCacheFiles(a).length, 0, 'failed pull must not create a cache entry');

  online(sb);
  write(path.join(b.context, 'projects', 'retry.md'), '# retry\nRETRY-OK\n');
  assert.equal(pctx(b, ['sync']).status, 0);
  const hRetry = hookWithInput(a, { cwd: a.work, source: 'startup' });
  assert.equal(hRetry.status, 0);
  assert.doesNotMatch(hRetry.stdout, /WARNING:/);
  assert.ok(fs.existsSync(path.join(a.context, 'projects', 'retry.md')));
  const cacheFiles = hookCacheFiles(a);
  assert.equal(cacheFiles.length, 1);

  // 2) Pull ok + pending push failure is also not cached; next hook retries the pending push.
  write(path.join(a.context, 'projects', 'pending.md'), '# pending\n');
  git(['-C', a.context, 'add', '-A']);
  git(['-C', a.context, 'commit', '-q', '-m', 'pending commit']);
  const preReceive = path.join(sb.remote, 'hooks', 'pre-receive');
  write(preReceive, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(preReceive, 0o755);

  const expiredAt = Date.now() - 125_000;
  write(cacheFiles[0], `${JSON.stringify({ refreshedAt: expiredAt })}\n`);
  const hPushFail = hookWithInput(a, { cwd: a.work, source: 'startup' });
  assert.equal(hPushFail.status, 0);
  assert.match(hPushFail.stdout, /WARNING: the context may be out of date \(Could not push:/);
  assert.equal(readJson(cacheFiles[0]).refreshedAt, expiredAt, 'failed push must not refresh timestamp');

  fs.rmSync(preReceive);
  const hPushOk = hookWithInput(a, { cwd: a.work, source: 'startup' });
  assert.equal(hPushOk.status, 0);
  assert.doesNotMatch(hPushOk.stdout, /WARNING:/);
  assert.ok(remoteFiles(sb).includes('projects/pending.md'), 'pending push retried when prior failure was not cached');
  assert.ok(readJson(cacheFiles[0]).refreshedAt > expiredAt);

  // 3) Corrupt JSON and future timestamps do not block the hook and get replaced on refresh.
  write(path.join(b.context, 'projects', 'corrupt.md'), '# corrupt\n');
  assert.equal(pctx(b, ['sync']).status, 0);
  write(cacheFiles[0], '{not valid json');
  assert.equal(hookWithInput(a, { cwd: a.work, source: 'startup' }).status, 0);
  assert.ok(fs.existsSync(path.join(a.context, 'projects', 'corrupt.md')));
  assert.ok(readJson(cacheFiles[0]).refreshedAt <= Date.now());

  write(path.join(b.context, 'projects', 'future.md'), '# future\n');
  assert.equal(pctx(b, ['sync']).status, 0);
  write(cacheFiles[0], `${JSON.stringify({ refreshedAt: Date.now() + 600_000 })}\n`);
  assert.equal(hookWithInput(a, { cwd: a.work, source: 'startup' }).status, 0);
  assert.ok(fs.existsSync(path.join(a.context, 'projects', 'future.md')));
  assert.ok(readJson(cacheFiles[0]).refreshedAt <= Date.now());

  // 4) Unwritable cache directory (blocked by a regular file) never blocks the hook.
  fs.rmSync(hookCacheDir(a), { recursive: true, force: true });
  write(hookCacheDir(a), 'not-a-directory\n');
  const hUnwritable = hookWithInput(a, { cwd: a.work, source: 'startup' });
  assert.equal(hUnwritable.status, 0);
  assert.ok(hUnwritable.stdout.includes('# Portable context'));
  assert.doesNotMatch(hUnwritable.stdout, /WARNING:/);
  fs.rmSync(hookCacheDir(a), { force: true });

  // 5) Remote URL credentials are never stored in cache filenames or contents.
  const secretToken = 'tok_super_secret_987654';
  git(['-C', a.context, 'remote', 'set-url', 'origin', `https://bot:${secretToken}@127.0.0.1:1/ctx.git`]);
  const hCredErr = hookWithInput(a, { cwd: a.work, source: 'startup' });
  assert.equal(hCredErr.status, 0);
  assert.ok(!hCredErr.stdout.includes(secretToken));
  for (const file of hookCacheFiles(a)) {
    assert.ok(!file.includes(secretToken));
    assert.ok(!fs.readFileSync(file, 'utf8').includes(secretToken));
  }
});

test('hook source="compact" skips pull, fetch, and push even with empty cache and hookRefreshSeconds 0', () => {
  const sb = makeSandbox();
  const teamRemote = makeRemote(sb, 'studio');
  const a = makeDevice(sb, 'laptop', { antigravity: true });
  const b = makeDevice(sb, 'desktop');
  setup(a, sb, ['--author', 'alice']);
  setup(b, sb, ['--author', 'bob']);
  teamAdd(a, 'studio', teamRemote);
  teamAdd(b, 'studio', teamRemote);

  // Set hookRefreshSeconds to 0 and ensure cache is completely empty.
  updateConfig(a, (cfg) => { cfg.hookRefreshSeconds = 0; });
  assert.equal(hookCacheFiles(a).length, 0);

  // Remote has newer commits from B in both personal and team repos.
  write(path.join(b.context, 'projects', 'app.md'), '# app\nREMOTE-PERSONAL-NEW\n');
  const bTeamDir = path.join(b.pctxHome, 'teams', 'studio');
  write(path.join(bTeamDir, 'projects', 'shared.md'), '# shared\nREMOTE-TEAM-NEW\n');
  assert.equal(pctx(b, ['sync']).status, 0);

  // A has local unpushed commits in both personal and team repos, plus local notes.
  const aTeamDir = path.join(a.pctxHome, 'teams', 'studio');
  write(path.join(a.context, 'projects', 'local-personal.md'), '# local-personal\nLOCAL-PERSONAL-UNPUSHED\n');
  git(['-C', a.context, 'add', '-A']);
  git(['-C', a.context, 'commit', '-q', '-m', 'local personal commit']);
  write(path.join(aTeamDir, 'projects', 'local-team.md'), '# local-team\n');
  git(['-C', aTeamDir, 'add', '-A']);
  git(['-C', aTeamDir, 'commit', '-q', '-m', 'local team commit']);

  const persRemoteHeadBefore = remoteHead(sb);
  const teamRemoteHeadBefore = git(['--git-dir', teamRemote, 'rev-parse', 'main']).stdout.trim();

  // Compact runs local-only: no pull, no fetch, no push, no cache written.
  const appDir = projectDir(a, 'local-personal');
  const hCompact = hookWithInput(a, { cwd: appDir, source: 'compact' });
  assert.equal(hCompact.status, 0, hCompact.stderr);
  assert.ok(hCompact.stdout.includes('LOCAL-PERSONAL-UNPUSHED'));
  assert.ok(!hCompact.stdout.includes('REMOTE-PERSONAL-NEW'));
  assert.ok(!hCompact.stdout.includes('REMOTE-TEAM-NEW'));
  assert.doesNotMatch(hCompact.stdout, /WARNING:/);
  assert.equal(remoteHead(sb), persRemoteHeadBefore, 'compact must not push personal commits');
  assert.equal(git(['--git-dir', teamRemote, 'rev-parse', 'main']).stdout.trim(), teamRemoteHeadBefore, 'compact must not push team commits');
  assert.equal(hookCacheFiles(a).length, 0, 'compact must not populate refresh cache');

  // Even Antigravity format respects source="compact" if provided, while omitting source refreshes when interval is 0.
  const hAgCompact = hookWithInput(a, { workspacePaths: [appDir], source: 'compact' }, ['--format', 'antigravity']);
  assert.equal(hAgCompact.status, 0);
  const agCompactText = JSON.parse(hAgCompact.stdout).injectSteps[0].systemMessage.systemMessage;
  assert.ok(agCompactText.includes('LOCAL-PERSONAL-UNPUSHED'));
  assert.equal(remoteHead(sb), persRemoteHeadBefore);

  // With hookRefreshSeconds: 0, normal startup pulls & pushes; consecutive normal calls also refresh.
  const hNormal = hookWithInput(a, { cwd: appDir, source: 'startup' });
  assert.equal(hNormal.status, 0);
  assert.doesNotMatch(hNormal.stdout, /WARNING:/);
  assert.ok(fs.existsSync(path.join(a.context, 'projects', 'app.md')));
  assert.notEqual(remoteHead(sb), persRemoteHeadBefore, 'startup with hookRefreshSeconds 0 pushes pending commit');
  assert.notEqual(git(['--git-dir', teamRemote, 'rev-parse', 'main']).stdout.trim(), teamRemoteHeadBefore);

  write(path.join(b.context, 'projects', 'zero.md'), '# zero\n');
  assert.equal(pctx(b, ['sync']).status, 0);
  assert.equal(hookWithInput(a, { cwd: appDir, source: 'resume' }).status, 0);
  assert.ok(fs.existsSync(path.join(a.context, 'projects', 'zero.md')), 'hookRefreshSeconds 0 disables interval between normal hooks');
  assert.ok(!fs.existsSync(path.join(a.pctxHome, 'hook-refresh')), 'a disabled interval does not write a cache');
});

test('isolated scope keeps per-repo timestamps separate, stays isolated on compact/expiration, and validates hookRefreshSeconds', () => {
  const sb = makeSandbox();
  const studioRemote = makeRemote(sb, 'studio-team');
  const acmeRemote = makeRemote(sb, 'acme-team');
  const acmePrivRemote = makeRemote(sb, 'acme-priv');
  const alex = makeDevice(sb, 'alex-laptop');
  const sam = makeDevice(sb, 'sam-pc');

  setup(alex, sb, ['--author', 'alex', '--project-identity', 'remote']);
  setup(sam, sb, ['--author', 'sam', '--project-identity', 'remote']);
  teamAdd(alex, 'studio', studioRemote);
  teamAdd(alex, 'acme', acmeRemote, [
    '--isolated',
    '--namespace', 'git.acme.example/platform',
    '--private-url', acmePrivRemote,
  ]);
  teamAdd(sam, 'studio', studioRemote);
  teamAdd(sam, 'acme', acmeRemote, ['--isolated', '--namespace', 'git.acme.example/platform']);

  const persProj = makeProjectRepo(alex, 'solo', 'https://github.com/alex/solo.git');
  const corpProj = makeProjectRepo(alex, 'payments', 'https://git.acme.example/platform/payments.git');

  // 1) Personal hook warms personal + studio caches, never touching isolated acme/acme-private.
  assert.equal(hookWithInput(alex, { cwd: persProj, source: 'startup' }).status, 0);
  const persAndStudioCaches = new Set(hookCacheFiles(alex));
  assert.equal(persAndStudioCaches.size, 2);

  // Sam updates both studio and acme remotes.
  const samStudioDir = path.join(sam.pctxHome, 'teams', 'studio');
  const samAcmeDir = path.join(sam.pctxHome, 'teams', 'acme');
  write(path.join(samStudioDir, 'AGENTS.md'), 'SAM-STUDIO-PROFILE\n');
  write(path.join(samAcmeDir, 'AGENTS.md'), 'SAM-ACME-PROFILE\n');
  assert.equal(pctx(sam, ['sync', '--cwd', sam.work]).status, 0);
  assert.equal(pctx(sam, ['sync', '--team', 'acme']).status, 0);

  // Backdate personal + studio caches so personal hook refreshes only personal + studio, never acme.
  const acmeHeadBefore = git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim();
  const acmeDir = path.join(alex.pctxHome, 'teams', 'acme');
  const acmePrivDir = path.join(alex.pctxHome, 'teams', 'acme-private');
  write(path.join(acmeDir, 'projects', 'unpushed-acme.md'), '# unpushed\n');
  git(['-C', acmeDir, 'add', '-A']);
  git(['-C', acmeDir, 'commit', '-q', '-m', 'unpushed acme']);

  for (const file of persAndStudioCaches) {
    write(file, `${JSON.stringify({ refreshedAt: Date.now() - 125_000 })}\n`);
  }
  const hPersExpired = hookWithInput(alex, { cwd: persProj, source: 'startup' });
  assert.equal(hPersExpired.status, 0);
  assert.ok(fs.readFileSync(path.join(alex.pctxHome, 'teams', 'studio', 'AGENTS.md'), 'utf8').includes('SAM-STUDIO-PROFILE'));
  assert.equal(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore, 'expired personal hook must not push isolated team');
  assert.equal(hookCacheFiles(alex).length, 2, 'expired personal hook must not cache isolated repos');

  // 2) Compact inside isolated corpProj outputs local isolated context without pulling or pushing acme/acme-priv or personal.
  write(path.join(acmePrivDir, 'projects', 'unpushed-priv.md'), '# unpushed priv\n');
  git(['-C', acmePrivDir, 'add', '-A']);
  git(['-C', acmePrivDir, 'commit', '-q', '-m', 'unpushed priv']);
  const privHeadBefore = git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim();

  updateConfig(alex, (cfg) => { cfg.hookRefreshSeconds = 0; });
  const hCorpCompact = hookWithInput(alex, { cwd: corpProj, source: 'compact' });
  assert.equal(hCorpCompact.status, 0);
  assert.ok(hCorpCompact.stdout.includes('# Portable context (team acme)'));
  assert.ok(!hCorpCompact.stdout.includes('SAM-ACME-PROFILE'), 'compact in isolated scope must not pull');
  assert.ok(!hCorpCompact.stdout.includes(alex.context));
  assert.equal(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore, 'compact must not push isolated team');
  assert.equal(git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim(), privHeadBefore, 'compact must not push isolated private');

  // 3) Normal isolated hook refreshes acme & acme-private independently, and warm cache still validates privateDir locally.
  updateConfig(alex, (cfg) => { delete cfg.hookRefreshSeconds; });
  const hCorp = hookWithInput(alex, { cwd: corpProj, source: 'startup' });
  assert.equal(hCorp.status, 0);
  assert.ok(hCorp.stdout.includes('SAM-ACME-PROFILE'));
  assert.notEqual(git(['--git-dir', acmeRemote, 'rev-parse', 'main']).stdout.trim(), acmeHeadBefore);
  assert.notEqual(git(['--git-dir', acmePrivRemote, 'rev-parse', 'main']).stdout.trim(), privHeadBefore);
  assert.equal(hookCacheFiles(alex).length, 4, 'personal, studio, acme, and acme-private each have distinct cache files');

  // Warm isolated hook still runs local privateDir validation.
  fs.rmSync(acmePrivDir, { recursive: true, force: true });
  const hBrokenPriv = hookWithInput(alex, { cwd: corpProj, source: 'resume' });
  assert.equal(hBrokenPriv.status, 0);
  assert.match(hBrokenPriv.stdout, /WARNING: private acme may be out of date/);

  // 4) Invalid hookRefreshSeconds fails cleanly in doctor, sync, and hook (hook still exits 0).
  updateConfig(alex, (cfg) => { cfg.hookRefreshSeconds = -1; });
  const doc = pctx(alex, ['doctor']);
  assert.equal(doc.status, 0);
  assert.match(doc.stdout, /Config problem: Invalid hookRefreshSeconds/);
  const badSync = pctx(alex, ['sync', '--cwd', persProj]);
  assert.equal(badSync.status, 1);
  assert.match(badSync.stderr, /Invalid hookRefreshSeconds/);
  const badHook = hookWithInput(alex, { cwd: persProj, source: 'startup' });
  assert.equal(badHook.status, 0);
  assert.match(badHook.stdout, /^Portable context unavailable: Invalid hookRefreshSeconds/);
});
