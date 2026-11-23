import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isInsideDir,
  matchesNamespace,
  parseNamespace,
  parseRemote,
  pathsOverlap,
  redactText,
  redactUrl,
  remoteProjectId,
  resolveLimits,
  resolveStaleSaveDays,
  localProjectId,
  validateConfig,
} from '../src/identity.js';

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

test('parseRemote treats HTTPS, SSH, SCP, and nested paths consistently for default ports', () => {
  const variants = [
    'https://git.acme.example/Platform/Billing/API.git',
    'https://alice:s3cr3t-token@git.acme.example:443/Platform/Billing/API.git/',
    'ssh://git@git.acme.example/Platform/Billing/API.git',
    'ssh://git@git.acme.example:22/Platform/Billing/API.git',
    'git@git.acme.example:Platform/Billing/API.git',
    'git@git.acme.example:/Platform/Billing/API',
  ];
  const parsed = variants.map((u) => parseRemote(u));
  for (const item of parsed) {
    assert.ok(item);
    assert.equal(item.kind, 'remote');
    assert.equal(item.canonical, 'git.acme.example/Platform/Billing/API');
  }
  const ids = new Set(parsed.map((item) => remoteProjectId(item)));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^[a-z0-9-]+--[0-9a-f]{10}$/);
});

test('parseRemote preserves path capitalization and non-default ports', () => {
  const upper = parseRemote('https://git.acme.example/Platform/Billing/API.git');
  const lower = parseRemote('https://git.acme.example/platform/billing/api.git');
  assert.equal(upper.canonical, 'git.acme.example/Platform/Billing/API');
  assert.equal(lower.canonical, 'git.acme.example/platform/billing/api');
  assert.notEqual(remoteProjectId(upper), remoteProjectId(lower));

  const ports = [
    parseRemote('https://git.acme.example/platform/api.git'),
    parseRemote('https://git.acme.example:8443/platform/api.git'),
    parseRemote('https://git.acme.example:9443/platform/api.git'),
    parseRemote('ssh://git@git.acme.example:2222/platform/api.git'),
    parseRemote('ssh://git@git.acme.example:2223/platform/api.git'),
  ];
  const canonicals = new Set(ports.map((p) => p.canonical));
  const ids = new Set(ports.map((p) => remoteProjectId(p)));
  assert.equal(canonicals.size, 5);
  assert.equal(ids.size, 5);
  assert.equal(
    parseRemote('git.acme.example:8443/platform/api', { allowShorthand: true })?.canonical,
    'git.acme.example:8443/platform/api',
  );
});

test('parseRemote handles Windows local paths without confusing drive letters for SSH hosts', () => {
  const winBack = parseRemote('C:\\Users\\Alex\\Repos\\my-app.git');
  const winSlash = parseRemote('C:/Users/Alex/Repos/my-app.git');
  const fileUrl = parseRemote('file:///C:/Users/Alex/Repos/my-app.git');
  assert.ok(winBack && winSlash && fileUrl);
  assert.equal(winBack.kind, 'local');
  assert.equal(winBack.canonical, winSlash.canonical);
  assert.equal(winBack.canonical, fileUrl.canonical);

  const unc = parseRemote('\\\\fileserver\\git\\team\\app.git');
  assert.ok(unc);
  assert.equal(unc.kind, 'local');
  assert.equal(unc.host, 'fileserver');
});

test('parseRemote rejects traversal, ext:: helpers, and unsafe inputs', () => {
  for (const bad of [
    '',
    'https://git.acme.example/org/../secret.git',
    'https://git.acme.example/org/%2e%2e/secret.git',
    'git@git.acme.example:org/../../secret.git',
    'ext::sh -c whoami',
    'javascript:alert(1)',
    'https://git.acme.example/.git',
  ]) {
    assert.equal(parseRemote(bad), null, `expected null for ${bad}`);
  }
});

test('remoteProjectId prevents collisions and bounds filename length', () => {
  const a = parseRemote('https://git.acme.example/a-b/c.git');
  const b = parseRemote('https://git.acme.example/a/b-c.git');
  assert.notEqual(remoteProjectId(a), remoteProjectId(b));

  const longUrl = `https://git.acme.example/${'sub/'.repeat(40)}very-long-service-name.git`;
  const longId = remoteProjectId(parseRemote(longUrl));
  assert.ok(longId.length <= 76, `too long: ${longId.length}`);
  assert.match(longId, /^[a-z0-9-]+--[0-9a-f]{10}$/);

  const localId = localProjectId('a-b');
  assert.match(localId, /^local--a-b$/);
  assert.notEqual(localId, remoteProjectId(a));
});

test('redactUrl and redactText strip credentials from HTTPS, SSH, and SCP remotes', () => {
  const cred = 'super_secret_token_123';
  for (const url of [
    `https://alice:${cred}@git.acme.example/platform/api.git`,
    `ssh://deploy:${cred}@git.acme.example:2222/platform/api.git`,
    `deploy:${cred}@git.acme.example:platform/api.git`,
  ]) {
    const out = redactUrl(url);
    assert.ok(!out.includes(cred), `credential leaked in ${out}`);
    assert.ok(out.includes('***@'));
  }
  const errText = redactText(`fatal: could not read from https://bot:${cred}@git.acme.example/team/repo.git`);
  assert.ok(!errText.includes(cred));
});

test('parseNamespace and matchesNamespace enforce segment boundaries and reject wildcards', () => {
  const ns = parseNamespace('git.acme.example/platform');
  assert.ok(ns);
  assert.ok(matchesNamespace(parseRemote('https://git.acme.example/platform/api.git'), ns));
  assert.ok(matchesNamespace(parseRemote('git@git.acme.example:platform/sub/svc.git'), ns));
  assert.ok(!matchesNamespace(parseRemote('https://git.acme.example/platform-v2/api.git'), ns));
  assert.ok(!matchesNamespace(parseRemote('https://github.com/platform/api.git'), ns));

  const hostNs = parseNamespace('git.acme.example/*');
  assert.ok(hostNs);
  assert.ok(matchesNamespace(parseRemote('https://git.acme.example/any/repo.git'), hostNs));
  assert.ok(!matchesNamespace(parseRemote('https://git.acme.example:8443/any/repo.git'), hostNs));

  const portNs = parseNamespace('git.acme.example:8443/Platform');
  assert.ok(portNs);
  assert.ok(matchesNamespace(parseRemote('https://git.acme.example:8443/Platform/api.git'), portNs));
  assert.ok(!matchesNamespace(parseRemote('https://git.acme.example:9443/Platform/api.git'), portNs));
  assert.ok(!matchesNamespace(parseRemote('https://git.acme.example/Platform/api.git'), portNs));
  assert.ok(!matchesNamespace(parseRemote('https://git.acme.example:8443/platform/api.git'), portNs));
  assert.ok(matchesNamespace(parseRemote('https://git.acme.example:8443/platform/api.git'), portNs, { caseInsensitivePath: true }));
  assert.ok(!matchesNamespace(parseRemote('https://git.acme.example:8443/platform-v2/api.git'), portNs, { caseInsensitivePath: true }));

  for (const bad of ['*', '*/*', 'acme', 'git.acme.example/*/api', '']) {
    assert.equal(parseNamespace(bad), null, `expected null for ${bad}`);
  }
});

test('pathsOverlap detects symlinks, trailing slashes, and nested directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-id-test-'));
  tmpDirs.push(root);
  const realDir = path.join(root, 'real-context');
  fs.mkdirSync(realDir);
  const linkDir = path.join(root, 'link-context');
  fs.symlinkSync(realDir, linkDir);

  assert.ok(pathsOverlap(realDir, linkDir));
  assert.ok(pathsOverlap(`${realDir}/`, linkDir));
  assert.ok(pathsOverlap(realDir, path.join(linkDir, 'nested', 'priv')));
  assert.ok(!pathsOverlap(realDir, path.join(root, 'other-dir')));
});

test('validateConfig checks per-repo scanRules and privateScanRules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-cfg-test-'));
  tmpDirs.push(root);
  const validCfg = {
    contextDir: path.join(root, 'ctx'),
    scanRules: ['es-dni', 'es-iban'],
    teams: [
      {
        name: 'acme',
        dir: path.join(root, 'acme'),
        isolated: true,
        namespaces: ['git.acme.example/platform'],
        privateDir: path.join(root, 'acme-priv'),
        scanRules: ['es-pii'],
        privateScanRules: ['es-mobile'],
      },
    ],
  };
  assert.doesNotThrow(() => validateConfig(validCfg));

  assert.throws(() => validateConfig({ ...validCfg, scanRules: ['bogus-rule'] }), /Unknown rule/);
  assert.throws(() => validateConfig({ ...validCfg, scanRules: 'es-pii' }), /must be an array/);
  assert.throws(
    () =>
      validateConfig({
        ...validCfg,
        teams: [{ ...validCfg.teams[0], scanRules: ['es-bad'] }],
      }),
    /Unknown rule/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...validCfg,
        teams: [{ ...validCfg.teams[0], privateDir: undefined, privateScanRules: ['es-dni'] }],
      }),
    /without privateDir/,
  );
});

test('resolveLimits and validateConfig enforce bounded positive integers for per-file limits', () => {
  assert.deepEqual(resolveLimits({}), { profile: 3000, project: 4000, decision: 1500 });
  assert.deepEqual(resolveLimits({ limits: { decision: 2200 } }), { profile: 3000, project: 4000, decision: 2200 });
  assert.doesNotThrow(() => validateConfig({ limits: { profile: 1, project: 100_000, decision: 500 } }));

  for (const badLimits of [null, '3000', [], 42]) {
    assert.throws(() => validateConfig({ limits: badLimits }), /Invalid limits in config\.json/);
  }
  assert.throws(() => validateConfig({ limits: { decisions: 500 } }), /Unknown key "decisions"/);
  assert.throws(() => validateConfig({ limits: JSON.parse('{"__proto__": 10}') }), /Unknown key "__proto__"/);

  for (const badVal of [0, -1, 1.5, '3000', true, null, 100_001]) {
    assert.throws(() => validateConfig({ limits: { profile: badVal } }), /Invalid limits\.profile/);
    assert.throws(() => validateConfig({ limits: { project: badVal } }), /Invalid limits\.project/);
    assert.throws(() => validateConfig({ limits: { decision: badVal } }), /Invalid limits\.decision/);
  }
});

test('resolveStaleSaveDays and validateConfig validate staleSaveDays bounds and Windows/POSIX path helpers', () => {
  assert.equal(resolveStaleSaveDays({}), 7);
  assert.equal(resolveStaleSaveDays({ staleSaveDays: 0 }), 0);
  assert.equal(resolveStaleSaveDays({ staleSaveDays: 3650 }), 3650);
  assert.doesNotThrow(() => validateConfig({ staleSaveDays: 0 }));

  for (const badDays of [-1, 1.5, '7', null, true, 3651]) {
    assert.throws(() => validateConfig({ staleSaveDays: badDays }), /Invalid staleSaveDays/);
  }

  // Windows drive/UNC and POSIX path parsing + isInsideDir regression.
  const winDrive = parseRemote('D:\\Work\\Repos\\My-App.git');
  const winSlash = parseRemote('D:/Work/Repos/My-App.git');
  assert.equal(winDrive.kind, 'local');
  assert.equal(winDrive.canonical, winSlash.canonical);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-native-'));
  tmpDirs.push(root);
  const inside = path.join(root, 'decisions', 'app.md');
  const outside = path.join(path.dirname(root), 'other', 'app.md');
  assert.ok(isInsideDir(inside, root));
  assert.ok(!isInsideDir(outside, root));
});
