const RULES = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['slack-token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['connection-string', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]+@[^\s/]+/i],
];

const GENERIC = /(?:api[_-]?key|secret|token|password)[\w.-]*["'`*\]]*\s*[:=]\s*["'`]?[^\s"'`]{16,}/i;

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function matchedRules(text) {
  const rules = RULES.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  // A specific rule already names the problem; the generic one would only repeat it.
  return rules.length === 0 && GENERIC.test(text) ? ['generic-secret'] : rules;
}

function parseNewPath(header) {
  let path = header.slice(4).replace(/\t.*$/, '');
  if (path.startsWith('"')) path = path.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

export function scanDiff(diffText) {
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
      for (const rule of matchedRules(line.slice(1))) findings.push({ file, line: lineNo, rule });
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
