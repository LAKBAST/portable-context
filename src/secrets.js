const RULES = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['slack-token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['google-oauth-secret', /\bGOCSPX-[0-9A-Za-z_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['connection-string', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]+@[^\s/]+/i],
];

// The lookahead skips references to a secret, which are safe and common in notes about code.
const GENERIC =
  /(?:api[_-]?key|secret|token|password)[\w.-]*["'`*\]]*\s*[:=]\s*["'`]?(?!process\.env\.|os\.environ|import\.meta\.env\.|\$\{)[^\s"'`]{16,}/i;

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const DNI_CONTROL = 'TRWAGMYFPDXBNJZSQVHLCKE';
const NIE_PREFIX = { X: '0', Y: '1', Z: '2' };

const DNI_CANDIDATE = /(?<![A-Za-z0-9])(?<!\d\.)(\d{8}|\d{2}\.\d{3}\.\d{3})[- ]?([A-Za-z])(?![A-Za-z0-9])/g;
const NIE_CANDIDATE = /(?<![A-Za-z0-9])(?<!\d\.)([XYZxyz])[- ]?(\d{7}|\d\.\d{3}\.\d{3})[- ]?([A-Za-z])(?![A-Za-z0-9])/g;
const IBAN_CANDIDATE = /(?<![A-Za-z0-9])(ES\d{2}(?:[ -]?\d){20})(?![A-Za-z0-9])(?![ -]?\d)/gi;
const ES_MOBILE_PATTERN =
  /(?:(?<![A-Za-z0-9+])\(\+34\)|(?<![A-Za-z0-9+])\+34)[ .-]?(?:[67]\d{8}|[67]\d{2}[ .-]\d{3}[ .-]\d{3}|[67]\d{2}[ .-]\d{2}[ .-]\d{2}[ .-]\d{2}|[67]\d{2}[ .-]\d{6})(?![A-Za-z0-9])(?![ .-]?\d)/;

export function isValidSpanishDni(value) {
  const clean = String(value ?? '').trim().replace(/[.\s-]+/g, '').toUpperCase();
  const match = /^(\d{8})([A-Z])$/.exec(clean);
  if (!match) return false;
  return DNI_CONTROL[Number(match[1]) % 23] === match[2];
}

export function isValidSpanishNie(value) {
  const clean = String(value ?? '').trim().replace(/[.\s-]+/g, '').toUpperCase();
  const match = /^([XYZ])(\d{7})([A-Z])$/.exec(clean);
  if (!match) return false;
  const num = Number(`${NIE_PREFIX[match[1]]}${match[2]}`);
  return DNI_CONTROL[num % 23] === match[3];
}

export function isValidSpanishIban(value) {
  const clean = String(value ?? '').trim().replace(/[\s-]+/g, '').toUpperCase();
  if (!/^ES\d{22}$/.test(clean)) return false;
  // ISO 13616 / 7064 mod-97: move country + check digits to the end, convert E=14, S=28.
  const numeric = `${clean.slice(4)}1428${clean.slice(2, 4)}`;
  let rem = 0;
  for (let i = 0; i < numeric.length; i += 1) {
    rem = (rem * 10 + Number(numeric[i])) % 97;
  }
  return rem === 1;
}

function hasValidCandidate(text, pattern, validate) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (validate(match)) return true;
  }
  return false;
}

const PERSONAL_DATA_RULES = new Map([
  ['es-dni', (text) => hasValidCandidate(text, DNI_CANDIDATE, (m) => isValidSpanishDni(`${m[1]}${m[2]}`))],
  ['es-nie', (text) => hasValidCandidate(text, NIE_CANDIDATE, (m) => isValidSpanishNie(`${m[1]}${m[2]}${m[3]}`))],
  ['es-iban', (text) => hasValidCandidate(text, IBAN_CANDIDATE, (m) => isValidSpanishIban(m[1]))],
  ['es-mobile', (text) => ES_MOBILE_PATTERN.test(text)],
]);

export const PERSONAL_DATA_RULE_IDS = Object.freeze([...PERSONAL_DATA_RULES.keys()]);

export const RULE_COLLECTIONS = Object.freeze({
  'es-pii': [...PERSONAL_DATA_RULE_IDS],
});

const VALID_RULE_IDS_TEXT = [...Object.keys(RULE_COLLECTIONS), ...PERSONAL_DATA_RULE_IDS].join(', ');

export function isPersonalDataRule(ruleId) {
  return PERSONAL_DATA_RULES.has(ruleId);
}

export function resolveScanRules(rules, label = 'scanRules') {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) {
    throw new Error(`${label} must be an array of built-in rule or collection IDs`);
  }
  const resolved = [];
  const seen = new Set();
  for (const entry of rules) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label} entries must be non-empty rule ID strings (valid IDs: ${VALID_RULE_IDS_TEXT})`);
    }
    const expanded = RULE_COLLECTIONS[entry] ?? (PERSONAL_DATA_RULES.has(entry) ? [entry] : null);
    if (!expanded) {
      throw new Error(`Unknown rule "${entry}" in ${label} (valid IDs: ${VALID_RULE_IDS_TEXT})`);
    }
    for (const id of expanded) {
      if (!seen.has(id)) {
        seen.add(id);
        resolved.push(id);
      }
    }
  }
  return resolved;
}

function matchedCredentialRules(text) {
  const rules = RULES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  // A specific rule already names the problem; the generic one would only repeat it.
  return rules.length === 0 && GENERIC.test(text) ? ['generic-secret'] : rules;
}

function matchedPersonalDataRules(text, enabledPersonalRules) {
  if (!enabledPersonalRules.length) return [];
  const rules = [];
  for (const id of enabledPersonalRules) {
    const detector = PERSONAL_DATA_RULES.get(id);
    if (detector?.(text)) rules.push(id);
  }
  return rules;
}

function matchedRules(text, enabledPersonalRules = []) {
  return [...matchedCredentialRules(text), ...matchedPersonalDataRules(text, enabledPersonalRules)];
}

function parseNewPath(header) {
  let path = header.slice(4).replace(/\t.*$/, '');
  if (path.startsWith('"')) path = path.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

export function scanDiff(diffText, { rules = [] } = {}) {
  const enabledPersonalRules = resolveScanRules(rules, 'scanDiff rules');
  const findings = [];
  let file = null;
  let lineNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;

  for (const raw of String(diffText ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
      oldLeft = newLeft = 0;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      lineNo = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      inHunk = true;
      continue;
    }
    // Inside a hunk "+++ x" is an added line starting with "++ x"; the counts tell them apart.
    if (oldLeft <= 0 && newLeft <= 0) {
      if (line.startsWith('+++ ')) {
        file = parseNewPath(line);
        inHunk = false;
        continue;
      }
      if (line.startsWith('--- ')) {
        inHunk = false;
        continue;
      }
    }
    if (!inHunk) continue;
    if (line[0] === '+') {
      for (const rule of matchedRules(line.slice(1), enabledPersonalRules)) findings.push({ file, line: lineNo, rule });
      lineNo += 1;
      newLeft -= 1;
    } else if (line[0] === '-') {
      oldLeft -= 1;
    } else if (line[0] === ' ') {
      lineNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return findings;
}
