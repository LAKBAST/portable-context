import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSpanishDni,
  isValidSpanishIban,
  isValidSpanishNie,
  resolveScanRules,
  scanDiff,
} from '../src/secrets.js';

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
  'google oauth client secret': 'GOCSPX-' + alnum(28),
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

test('scanDiff ignores references to a secret but still flags literal values', () => {
  const diff = (line) => `diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -0,0 +1 @@\n+${line}\n`;
  for (const reference of [
    'token=process.env.GITHUB_TOKEN',
    'apiKey: process.env.STRIPE_SECRET_KEY',
    'password = os.environ["DATABASE_PASSWORD"]',
    'secret: import.meta.env.VITE_SECRET_VALUE',
    'API_KEY=${MY_LONG_API_KEY_VALUE}',
  ]) {
    assert.deepEqual(scanDiff(diff(reference)), [], reference);
  }
  const literal = scanDiff(diff('password=' + 'x7Q2'.repeat(5)));
  assert.equal(literal.length, 1);
  assert.equal(literal[0].rule, 'generic-secret');
});

test('checksum validators verify Spanish DNI, NIE, and IBAN control characters', () => {
  // Synthetic mod-23 DNI/NIE and mod-97 IBAN values.
  assert.equal(isValidSpanishDni('00000001R'), true);
  assert.equal(isValidSpanishDni('00.000.001-r'), true);
  assert.equal(isValidSpanishDni('12345678Z'), true);
  assert.equal(isValidSpanishDni('00000001A'), false);
  assert.equal(isValidSpanishDni('0000001R'), false);
  assert.equal(isValidSpanishDni('X0000000T'), false);

  assert.equal(isValidSpanishNie('X0000000T'), true);
  assert.equal(isValidSpanishNie('y-0000000-z'), true);
  assert.equal(isValidSpanishNie('Z0000000M'), true);
  assert.equal(isValidSpanishNie('X0000000A'), false);
  assert.equal(isValidSpanishNie('A0000000T'), false);

  assert.equal(isValidSpanishIban('ES8200000000000000000000'), true);
  assert.equal(isValidSpanishIban('ES55 0000 0000 0000 0000 0001'), true);
  assert.equal(isValidSpanishIban('es55-0000-0000-0000-0000-0001'), true);
  assert.equal(isValidSpanishIban('ES8300000000000000000000'), false);
  assert.equal(isValidSpanishIban('ES820000000000000000000'), false);
  assert.equal(isValidSpanishIban('FR7630006000011234567890189'), false);
});

test('resolveScanRules expands collections, deduplicates, and rejects invalid names or types', () => {
  assert.deepEqual(resolveScanRules(undefined), []);
  assert.deepEqual(resolveScanRules([]), []);
  assert.deepEqual(resolveScanRules(['es-pii']), ['es-dni', 'es-nie', 'es-iban', 'es-mobile']);
  assert.deepEqual(resolveScanRules(['es-dni', 'es-iban', 'es-dni']), ['es-dni', 'es-iban']);
  assert.deepEqual(resolveScanRules(['es-pii', 'es-dni']), ['es-dni', 'es-nie', 'es-iban', 'es-mobile']);

  for (const bad of ['es-pii', 42, null, {}, [''], [123], ['unknown-rule'], ['es-dni '], ['/\\d+/']]) {
    assert.throws(() => resolveScanRules(bad, 'testRules'));
  }
});

test('scanDiff keeps personal data disabled by default while blocking GOCSPX- globally', () => {
  const oauthSecret = 'GOCSPX-' + alnum(28);
  const personalLine = 'DNI 00000001R NIE X0000000T IBAN ES8200000000000000000000 TEL +34 600 000 000';
  assert.deepEqual(scanDiff(diffWith(personalLine)), []);

  const oauthOnly = scanDiff(diffWith(`client_secret=${oauthSecret}`));
  assert.deepEqual(oauthOnly, [{ file: 'notes.md', line: 3, rule: 'google-oauth-secret' }]);
  assert.ok(!JSON.stringify(oauthOnly).includes(oauthSecret));
});

test('scanDiff detects synthetic Spanish personal data when es-pii or individual rules are enabled', () => {
  const positives = [
    ['es-dni', 'DNI: 00000001R'],
    ['es-dni', 'DNI 12345678-z'],
    ['es-dni', '12.345.678 Z'],
    ['es-nie', 'NIE X0000000T'],
    ['es-nie', 'y-0000000-z'],
    ['es-nie', 'Z 0000000 M'],
    ['es-iban', 'ES8200000000000000000000'],
    ['es-iban', 'ES55 0000 0000 0000 0000 0001'],
    ['es-iban', 'ES55-0000-0000-0000-0000-0001'],
    ['es-iban', 'ES55 0000 0000 00 0000000001'],
    ['es-mobile', '+34600000000'],
    ['es-mobile', '+34 600 000 000'],
    ['es-mobile', '+34 700 00 00 00'],
    ['es-mobile', '+34-600-000-000'],
    ['es-mobile', '+34.700.000.000'],
    ['es-mobile', '(+34) 600 00 00 00'],
  ];

  for (const [expectedRule, text] of positives) {
    const found = scanDiff(diffWith(text), { rules: ['es-pii'] });
    assert.deepEqual(found, [{ file: 'notes.md', line: 3, rule: expectedRule }], text);
    assert.ok(!JSON.stringify(found).includes(text), 'finding must not leak detected value');
  }

  // Individual selection only activates the chosen rules.
  const onlyDni = scanDiff(
    diffWith('00000001R X0000000T ES8200000000000000000000 +34 600 000 000'),
    { rules: ['es-dni'] },
  );
  assert.deepEqual(onlyDni, [{ file: 'notes.md', line: 3, rule: 'es-dni' }]);
});

test('scanDiff rejects negative personal data cases (checksums, boundaries, embedded, foreign phones)', () => {
  const negatives = [
    // Bad checksums
    'DNI 00000001A',
    'NIE X0000000A',
    'NIE Y0000000A',
    'IBAN ES8300000000000000000000',
    'IBAN ES56 0000 0000 0000 0000 0001',
    // Length limits
    'DNI 0000001R',
    'DNI 000000001R',
    'NIE X000000T',
    'NIE X00000000T',
    'IBAN ES820000000000000000000',
    'IBAN ES82000000000000000000000',
    'IBAN ES55 0000 0000 0000 0000 0001 99',
    'TEL +34 600 000 00',
    'TEL +34 600 000 0001',
    'TEL +34 600 000 000 1',
    // Embedded tokens
    'ref00000001R',
    '00000001R9',
    '1.00000001R',
    'AX0000000T',
    'X0000000TB',
    'REFES8200000000000000000000',
    'ES8200000000000000000000XYZ',
    'id+34600000000',
    '+34600000000x',
    // Foreign phones, Spanish landlines, and numbers without +34
    '+33 600 000 000',
    '+44 7700 900077',
    '+1 600 000 0000',
    '+34 910 000 000',
    '+34 500 000 000',
    '600 000 000',
    // Foreign IBAN
    'FR7630006000011234567890189',
  ];

  for (const text of negatives) {
    assert.deepEqual(scanDiff(diffWith(text), { rules: ['es-pii'] }), [], `unexpected match for: ${text}`);
  }
});

test('scanDiff reports both credential and personal data rules together without suppressing generic-secret', () => {
  const oauthSecret = 'GOCSPX-' + alnum(28);
  const bothSpecific = scanDiff(diffWith(`secret=${oauthSecret} dni=00000001R`), { rules: ['es-dni'] });
  assert.deepEqual(bothSpecific, [
    { file: 'notes.md', line: 3, rule: 'google-oauth-secret' },
    { file: 'notes.md', line: 3, rule: 'es-dni' },
  ]);

  const genericAndPii = scanDiff(diffWith(`password=${'x7Q2'.repeat(5)} tel=+34600000000`), { rules: ['es-mobile'] });
  assert.deepEqual(genericAndPii, [
    { file: 'notes.md', line: 3, rule: 'generic-secret' },
    { file: 'notes.md', line: 3, rule: 'es-mobile' },
  ]);

  assert.throws(() => scanDiff(diffWith('clean'), { rules: ['not-a-rule'] }));
});
