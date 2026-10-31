import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDiff } from '../src/secrets.js';

// Fake secrets are built at runtime so that no literal token lives in this file.
const alnum = (n) => 'aB3dE5gH7j'.repeat(Math.ceil(n / 10)).slice(0, n);

const samples = {
  'github token': 'ghp_' + 'a'.repeat(36),
  'aws access key': 'AKIA' + 'ABCDEFGH12345678',
  'private key': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'slack token': 'xoxb-' + '1234567890-' + '1234567890-' + alnum(24),
  'anthropic key': 'sk-ant-' + 'api03-' + alnum(40),
  'openai key': 'sk-' + alnum(48),
  'google api key': 'AIza' + alnum(35),
};

function diffWith(addedLine, file = 'notes.md') {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,2 +1,3 @@',
    ' line one',
    ' line two',
    `+${addedLine}`,
    '',
  ].join('\n');
}

for (const [name, secret] of Object.entries(samples)) {
  test(`scanDiff detects ${name} on an added line`, () => {
    const found = scanDiff(diffWith(`value: ${secret}`));
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].file, 'notes.md');
    assert.equal(found[0].line, 3);
    assert.equal(typeof found[0].rule, 'string');
    assert.ok(found[0].rule.length > 0);
    assert.ok(!JSON.stringify(found).includes(secret), 'result must not contain the secret value');
  });
}

test('scanDiff ignores removed lines and context lines', () => {
  const secret = samples['github token'];
  const diff = [
    'diff --git a/a.md b/a.md',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,3 +1,2 @@',
    ` context ${secret}`,
    `-removed ${secret}`,
    '+harmless',
    '',
  ].join('\n');
  assert.deepEqual(scanDiff(diff), []);
});

test('scanDiff does not treat the +++ header as an added line', () => {
  assert.deepEqual(scanDiff(diffWith('nothing secret here')), []);
});

test('scanDiff reports file and line number per hunk', () => {
  const secret = samples['github token'];
  const diff = [
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -0,0 +1,2 @@',
    '+fine',
    `+key ${secret}`,
    'diff --git a/y.md b/y.md',
    '--- a/y.md',
    '+++ b/y.md',
    '@@ -10,1 +10,2 @@',
    ' keep',
    `+other ${secret}`,
    '',
  ].join('\n');
  const found = scanDiff(diff);
  assert.deepEqual(found.map((f) => [f.file, f.line]), [['x.md', 2], ['y.md', 11]]);
});

test('scanDiff returns [] for empty input', () => {
  assert.deepEqual(scanDiff(''), []);
});
