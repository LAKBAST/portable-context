import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { resolveScanRules } from './secrets.js';

const SAFE_STEM = /^[a-zA-Z0-9._-]+$/;
const DOMAIN_HOST = /^(?:localhost|\[[0-9a-fA-F:]+\]|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$/;
const REMOTE_ID_PATTERN = /^[a-z0-9-]+--[0-9a-f]{10}$/;
const LOCAL_ID_PATTERN = /^local--[a-z0-9-]+$/;
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'git+https:', 'file:']);
export const DEFAULT_LIMITS = { profile: 3000, project: 4000, decision: 1500 };
export const MAX_FILE_LIMIT = 100_000;
export const DEFAULT_STALE_SAVE_DAYS = 7;
export const MAX_STALE_SAVE_DAYS = 3650;
export const DEFAULT_HOOK_REFRESH_SECONDS = 120;
export const MAX_HOOK_REFRESH_SECONDS = 86_400;
const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS));
const DEFAULT_PORTS = {
  'http:': '80',
  'https:': '443',
  'git+https:': '443',
  'ssh:': '22',
  'git+ssh:': '22',
  'git:': '9418',
};
const TRAVERSAL_SEGMENT = /(?:^|[\\/])(?:\.|%2e){1,2}(?:[\\/]|$)/i;

function formatRemoteHost(hostname, port, protocol = null) {
  const lower = hostname.toLowerCase();
  if (!port) return lower;
  if (port === '0') return null;
  if (protocol && DEFAULT_PORTS[protocol] === port) return lower;
  return `${lower}:${port}`;
}

function parseHostWithPort(raw) {
  const m = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+):([1-9]\d{0,4})$/.exec(raw);
  if (!m) return null;
  const portNum = Number(m[2]);
  if (!DOMAIN_HOST.test(m[1]) || portNum < 1 || portNum > 65535) return null;
  return `${m[1].toLowerCase()}:${m[2]}`;
}

export function slug(value) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'general';
}

export function redactUrl(url) {
  return String(url ?? '')
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g, '$1***@')
    .replace(/(^|[\s"'(=])[^@/\s:]+:[^@\s]+@(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):/g, '$1***@$2:');
}

export function redactText(text) {
  return redactUrl(String(text ?? ''));
}

function hasControlChars(str) {
  return /[\x00-\x1f\x7f]/.test(str);
}

function normalizeLocalPath(rawPath, { resolveRelative = false } = {}) {
  let cleaned = rawPath.replaceAll('\\', '/');
  if (resolveRelative) {
    cleaned = resolve(rawPath).replaceAll('\\', '/');
  }
  const windowsDrive = /^[A-Za-z]:(?:\/|$)/.test(cleaned);
  let normalized = posix.normalize(cleaned);
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (windowsDrive) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
    if (process.platform === 'win32') normalized = normalized.toLowerCase();
  } else if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  normalized = normalized.replace(/\.git$/i, '');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function cleanRemoteSegments(rawSegments, { stripGit = true } = {}) {
  const segments = [];
  for (const rawSeg of rawSegments) {
    if (!rawSeg) continue;
    let seg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return null;
    }
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || hasControlChars(seg)) {
      return null;
    }
    segments.push(seg);
  }
  if (!segments.length) return null;
  if (stripGit) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '');
    if (!segments[segments.length - 1]) return null;
  }
  return segments;
}

export function parseRemote(raw, { allowShorthand = false } = {}) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || hasControlChars(s) || /^ext::/i.test(s)) return null;

  // Windows drive-letter local path (must run before SCP host:path matching).
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(s)) {
    const normalized = normalizeLocalPath(s);
    if (!normalized || /^[a-z]:\/?$/.test(normalized)) return null;
    return { kind: 'local', host: '', path: normalized, canonical: `local:${normalized}` };
  }

  // Windows UNC path: \\server\share\repo.git
  const uncMatch = /^\\\\([^\\]+)\\(.+)$/.exec(s);
  if (uncMatch) {
    const host = uncMatch[1].toLowerCase();
    const rest = normalizeLocalPath('/' + uncMatch[2]);
    if (!host || !rest || rest === '/') return null;
    return { kind: 'local', host, path: rest, canonical: `local://${host}${rest}` };
  }

  // Unix or relative local filesystem path.
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') {
    const normalized = normalizeLocalPath(s, { resolveRelative: !s.startsWith('/') });
    if (!normalized || normalized === '/') return null;
    return { kind: 'local', host: '', path: normalized, canonical: `local:${normalized}` };
  }

  // Scheme URL: https://, ssh://, git://, file://, etc.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    if (TRAVERSAL_SEGMENT.test(s.slice(s.indexOf('://') + 3))) return null;

    if (url.protocol === 'file:') {
      let filePath;
      try {
        filePath = decodeURIComponent(url.pathname);
      } catch {
        return null;
      }
      if (!filePath || hasControlChars(filePath)) return null;
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
        const host = url.hostname.toLowerCase();
        const rest = normalizeLocalPath(filePath);
        if (!rest || rest === '/') return null;
        return { kind: 'local', host, path: rest, canonical: `local://${host}${rest}` };
      }
      if (/^\/[A-Za-z]:(?:\/|$)/.test(filePath)) filePath = filePath.slice(1);
      const normalized = normalizeLocalPath(filePath);
      if (!normalized || normalized === '/' || /^[a-z]:\/?$/.test(normalized)) return null;
      return { kind: 'local', host: '', path: normalized, canonical: `local:${normalized}` };
    }

    if (!url.hostname || url.hostname.includes('*')) return null;
    const host = formatRemoteHost(url.hostname, url.port, url.protocol);
    if (!host) return null;
    const rawPath = url.pathname;
    if (rawPath.includes('\\')) return null;
    const segments = cleanRemoteSegments(rawPath.split('/'));
    if (!segments) return null;
    const cleanPath = segments.join('/');
    return { kind: 'remote', host, path: cleanPath, canonical: `${host}/${cleanPath}` };
  }

  // Canonical shorthand with non-default port: host:port/org/repo (only when allowShorthand is true).
  if (allowShorthand && !s.includes('@') && !s.includes('\\') && !s.includes('?') && !s.includes('#') && !s.includes('*')) {
    const slashAt = s.indexOf('/');
    if (slashAt > 0) {
      const maybeHostPort = parseHostWithPort(s.slice(0, slashAt));
      if (maybeHostPort) {
        const rest = s.slice(slashAt + 1);
        if (TRAVERSAL_SEGMENT.test(rest)) return null;
        const segments = cleanRemoteSegments(rest.split('/'));
        if (!segments) return null;
        const cleanPath = segments.join('/');
        return { kind: 'remote', host: maybeHostPort, path: cleanPath, canonical: `${maybeHostPort}/${cleanPath}` };
      }
    }
  }

  // SCP-like syntax: [user@]host:path (without @, require a valid domain/IPv6 host so URIs like javascript:x are rejected)
  const scpMatch = /^(?:([^@/\s]+)@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(.+)$/.exec(s);
  if (scpMatch && !s.includes('://')) {
    if (!scpMatch[1] && !DOMAIN_HOST.test(scpMatch[2])) return null;
    const host = scpMatch[2].toLowerCase();
    const rawPath = scpMatch[3];
    if (!rawPath || rawPath.includes('\\') || rawPath.includes('?') || rawPath.includes('#')) return null;
    if (TRAVERSAL_SEGMENT.test(rawPath)) return null;
    const segments = cleanRemoteSegments(rawPath.split('/'));
    if (!segments) return null;
    const cleanPath = segments.join('/');
    return { kind: 'remote', host, path: cleanPath, canonical: `${host}/${cleanPath}` };
  }

  // Canonical shorthand: host/org/repo (only when explicitly allowed, e.g. config or --project)
  if (allowShorthand && !s.includes('@') && !s.includes('\\') && !s.includes('?') && !s.includes('#') && !s.includes('*')) {
    if (TRAVERSAL_SEGMENT.test(s)) return null;
    const parts = s.split('/');
    if (parts.length < 2) return null;
    const [rawHost, ...rawRest] = parts;
    if (!DOMAIN_HOST.test(rawHost)) return null;
    const segments = cleanRemoteSegments(rawRest);
    if (!segments) return null;
    const host = rawHost.toLowerCase();
    const cleanPath = segments.join('/');
    return { kind: 'remote', host, path: cleanPath, canonical: `${host}/${cleanPath}` };
  }

  return null;
}

export function parseNamespace(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || hasControlChars(s) || /^ext::/i.test(s)) return null;
  if (TRAVERSAL_SEGMENT.test(s)) return null;

  s = s.replace(/[\\/]+\*$/, '').replace(/[\\/]+$/, '');
  if (!s || s.includes('*')) return null;

  const remote = parseRemote(s, { allowShorthand: true });
  if (remote) return remote;

  // Host-only namespace with scheme: https://git.example.com
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!ALLOWED_SCHEMES.has(url.protocol) || url.protocol === 'file:') return null;
    if (!url.hostname || url.hostname.includes('*') || (url.pathname && url.pathname !== '/')) return null;
    const host = formatRemoteHost(url.hostname, url.port, url.protocol);
    if (!host) return null;
    return { kind: 'remote', host, path: '', canonical: host };
  }

  // Host-only namespace without scheme: git.example.com or git.example.com:8443
  if (DOMAIN_HOST.test(s)) {
    const host = s.toLowerCase();
    return { kind: 'remote', host, path: '', canonical: host };
  }
  const hostWithPort = parseHostWithPort(s);
  if (hostWithPort) {
    return { kind: 'remote', host: hostWithPort, path: '', canonical: hostWithPort };
  }

  return null;
}

export function matchesNamespace(remoteParsed, nsParsed, { caseInsensitivePath = false } = {}) {
  if (!remoteParsed || !nsParsed || remoteParsed.kind !== nsParsed.kind) return false;
  if (remoteParsed.host !== nsParsed.host) return false;
  if (!nsParsed.path) return true;
  const remotePath = caseInsensitivePath ? remoteParsed.path.toLowerCase() : remoteParsed.path;
  const nsPath = caseInsensitivePath ? nsParsed.path.toLowerCase() : nsParsed.path;
  const prefix = nsPath === '/' ? '/' : `${nsPath}/`;
  return remotePath === nsPath || remotePath.startsWith(prefix);
}

export function remoteProjectId(parsed) {
  const hash = createHash('sha256').update(parsed.canonical).digest('hex').slice(0, 10);
  const readable = slug(parsed.canonical).slice(0, 64).replace(/-+$/, '') || 'project';
  return `${readable}--${hash}`;
}

export function localProjectId(name) {
  return `local--${slug(name).slice(0, 64).replace(/-+$/, '')}`;
}

export function isCanonicalProjectId(value) {
  return REMOTE_ID_PATTERN.test(value) || LOCAL_ID_PATTERN.test(value);
}

// Resolves symlinks through the deepest existing ancestor so non-existent targets
// inside symlinked folders still match their real destination.
export function normalizeRealPath(targetPath) {
  const abs = resolve(targetPath);
  const suffix = [];
  let cursor = abs;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ''));
    cursor = parent;
  }
  let base = cursor;
  if (existsSync(cursor)) {
    try {
      base = realpathSync.native(cursor);
    } catch {
      base = cursor;
    }
  }
  const combined = suffix.length ? resolve(base, ...suffix) : base;
  let normalized = combined.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function repoCommonDir(dir, gitFn) {
  if (!gitFn || !existsSync(joinGit(dir))) return null;
  const top = gitFn(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const common = gitFn(dir, ['rev-parse', '--git-common-dir']);
  if (!common.ok || !common.stdout.trim()) return normalizeRealPath(top.stdout.trim());
  const rawCommon = common.stdout.trim();
  const absCommon = isAbsolute(rawCommon) ? rawCommon : resolve(dir, rawCommon);
  return normalizeRealPath(absCommon);
}

function addDestinationKeys(keys, rawUrl, baseDir) {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return;
  const parsed = parseRemote(trimmed);
  if (!parsed) return;
  keys.add(parsed.canonical);
  if (parsed.kind === 'local' && !parsed.host) {
    let fsPath = trimmed;
    if (/^file:\/\//i.test(trimmed)) {
      try {
        fsPath = decodeURIComponent(new URL(trimmed).pathname);
        if (/^\/[A-Za-z]:(?:\/|$)/.test(fsPath)) fsPath = fsPath.slice(1);
      } catch {
        fsPath = '';
      }
    } else if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('./') || trimmed.startsWith('../')) {
      fsPath = resolve(baseDir, trimmed);
    }
    if (fsPath) {
      if (existsSync(fsPath)) {
        keys.add(`local-real:${normalizeRealPath(fsPath).replace(/\.git$/i, '')}`);
      } else if (!/\.git$/i.test(fsPath) && existsSync(`${fsPath}.git`)) {
        keys.add(`local-real:${normalizeRealPath(`${fsPath}.git`).replace(/\.git$/i, '')}`);
      }
    }
  }
}

function collectLines(res, keys, baseDir) {
  if (!res?.ok || !res.stdout) return;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.trim()) addDestinationKeys(keys, line, baseDir);
  }
}

function repoDestinationKeys(dir, gitFn, includePushTargets = false) {
  const keys = new Set();
  if (!gitFn || !existsSync(joinGit(dir))) return keys;
  collectLines(gitFn(dir, ['config', '--get', 'remote.origin.url']), keys, dir);
  if (!includePushTargets) return keys;

  collectLines(gitFn(dir, ['remote', 'get-url', '--all', 'origin']), keys, dir);
  collectLines(gitFn(dir, ['remote', 'get-url', '--push', '--all', 'origin']), keys, dir);
  collectLines(gitFn(dir, ['config', '--get-all', 'remote.origin.pushurl']), keys, dir);

  const pushTargets = [];
  const pushDefault = gitFn(dir, ['config', '--local', '--get', 'remote.pushDefault']);
  if (pushDefault.ok && pushDefault.stdout.trim()) pushTargets.push(pushDefault.stdout.trim());

  const branchRemotes = gitFn(dir, ['config', '--local', '--get-regexp', '^branch\\..*\\.(?:pushremote|remote)$']);
  if (branchRemotes.ok && branchRemotes.stdout) {
    for (const line of branchRemotes.stdout.split(/\r?\n/)) {
      const spaceAt = line.indexOf(' ');
      if (spaceAt !== -1) {
        const val = line.slice(spaceAt + 1).trim();
        if (val) pushTargets.push(val);
      }
    }
  }

  for (const target of new Set(pushTargets)) {
    if (!/[\\/:]/.test(target)) {
      collectLines(gitFn(dir, ['remote', 'get-url', '--push', '--all', target]), keys, dir);
      collectLines(gitFn(dir, ['remote', 'get-url', '--all', target]), keys, dir);
      collectLines(gitFn(dir, ['config', '--get-all', `remote.${target}.pushurl`]), keys, dir);
      collectLines(gitFn(dir, ['config', '--get', `remote.${target}.url`]), keys, dir);
    } else {
      addDestinationKeys(keys, target, dir);
    }
  }
  return keys;
}

export function isInsideDir(candidate, dir) {
  if (!candidate || !dir) return false;
  const rc = normalizeRealPath(candidate);
  const rd = normalizeRealPath(dir);
  return rc === rd || (rd !== '/' && rc.startsWith(`${rd}/`));
}

export function pathsOverlap(a, b, gitFn = null, { includePushTargets = false } = {}) {
  if (!a || !b) return false;
  const ra = normalizeRealPath(a);
  const rb = normalizeRealPath(b);
  if (ra === rb) return true;
  if (ra !== '/' && rb.startsWith(`${ra}/`)) return true;
  if (rb !== '/' && ra.startsWith(`${rb}/`)) return true;
  const ca = repoCommonDir(a, gitFn);
  const cb = repoCommonDir(b, gitFn);
  if (ca && cb && ca === cb) return true;
  const ka = repoDestinationKeys(a, gitFn, includePushTargets);
  const kb = repoDestinationKeys(b, gitFn, includePushTargets);
  for (const key of ka) {
    if (kb.has(key)) return true;
  }
  return false;
}

export function hasScopeRules(team) {
  return (Array.isArray(team?.remotes) && team.remotes.length > 0) ||
    (Array.isArray(team?.namespaces) && team.namespaces.length > 0);
}

export function teamMatchesRemote(team, remoteParsed, { caseInsensitivePath = false } = {}) {
  if (!remoteParsed || !team) return false;
  for (const raw of team.remotes ?? []) {
    const parsed = parseRemote(raw, { allowShorthand: true });
    if (!parsed || parsed.kind !== remoteParsed.kind || parsed.host !== remoteParsed.host) continue;
    const match = caseInsensitivePath
      ? parsed.path.toLowerCase() === remoteParsed.path.toLowerCase()
      : parsed.path === remoteParsed.path;
    if (match) return true;
  }
  for (const raw of team.namespaces ?? []) {
    const ns = parseNamespace(raw);
    if (ns && matchesNamespace(remoteParsed, ns, { caseInsensitivePath })) return true;
  }
  return false;
}

export function isSafeLegacyAliasKey(key) {
  return typeof key === 'string' && key.length > 0 && key !== '.' && key !== '..' && SAFE_STEM.test(key);
}

function validateAliases(aliases, label, isolatedTeams, ownTeam = null) {
  if (aliases === undefined) return [];
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new Error(`${label} must be an object mapping legacy project names to remote identities`);
  }
  const seenTargets = new Map();
  const entries = [];
  for (const [key, value] of Object.entries(aliases)) {
    if (!isSafeLegacyAliasKey(key)) {
      throw new Error(`Invalid alias name "${key}" in ${label}`);
    }
    const parsed = parseRemote(value, { allowShorthand: true });
    if (!parsed) {
      throw new Error(`Invalid remote "${redactUrl(String(value))}" for alias "${key}" in ${label}`);
    }
    if (seenTargets.has(parsed.canonical)) {
      throw new Error(`Multiple aliases in ${label} point to ${parsed.canonical}`);
    }
    seenTargets.set(parsed.canonical, key);
    if (ownTeam) {
      if (hasScopeRules(ownTeam) && !teamMatchesRemote(ownTeam, parsed)) {
        throw new Error(`Alias "${key}" in team ${ownTeam.name} points outside that team's scope`);
      }
    } else {
      const hit = isolatedTeams.find(
        (t) => teamMatchesRemote(t, parsed) || teamMatchesRemote(t, parsed, { caseInsensitivePath: true }),
      );
      if (hit) {
        throw new Error(`Personal alias "${key}" cannot point to isolated team ${hit.name}`);
      }
    }
    entries.push({ key, canonical: parsed.canonical, id: remoteProjectId(parsed), parsed });
  }
  return entries;
}

export function resolveLimits(config) {
  const result = { ...DEFAULT_LIMITS };
  const raw = config?.limits;
  if (raw === undefined) return result;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid limits in config.json: expected an object with optional keys profile, project, decision');
  }
  for (const key of Object.keys(raw)) {
    if (!LIMIT_KEYS.has(key)) {
      throw new Error(`Unknown key "${key}" in limits in config.json (expected profile, project, decision)`);
    }
    const value = raw[key];
    if (!Number.isInteger(value) || value < 1 || value > MAX_FILE_LIMIT) {
      throw new Error(`Invalid limits.${key} in config.json: expected an integer between 1 and ${MAX_FILE_LIMIT}`);
    }
    result[key] = value;
  }
  return result;
}

export function resolveStaleSaveDays(config) {
  const raw = config?.staleSaveDays;
  if (raw === undefined) return DEFAULT_STALE_SAVE_DAYS;
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_STALE_SAVE_DAYS) {
    throw new Error(
      `Invalid staleSaveDays in config.json: expected an integer between 0 and ${MAX_STALE_SAVE_DAYS} (0 disables)`,
    );
  }
  return raw;
}

export function resolveHookRefreshSeconds(config) {
  const raw = config?.hookRefreshSeconds;
  if (raw === undefined) return DEFAULT_HOOK_REFRESH_SECONDS;
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_HOOK_REFRESH_SECONDS) {
    throw new Error(
      `Invalid hookRefreshSeconds in config.json: expected an integer between 0 and ${MAX_HOOK_REFRESH_SECONDS} (0 disables)`,
    );
  }
  return raw;
}

export function validateConfig(config, gitFn = null) {
  if (!config || typeof config !== 'object') {
    return {
      mode: 'legacy',
      personalAliases: [],
      teamAliases: new Map(),
      limits: { ...DEFAULT_LIMITS },
      staleSaveDays: DEFAULT_STALE_SAVE_DAYS,
      hookRefreshSeconds: DEFAULT_HOOK_REFRESH_SECONDS,
    };
  }
  const mode = config.projectIdentity ?? 'legacy';
  if (mode !== 'legacy' && mode !== 'remote') {
    throw new Error(`Invalid projectIdentity "${mode}" in config.json (expected "legacy" or "remote")`);
  }
  const limits = resolveLimits(config);
  const staleSaveDays = resolveStaleSaveDays(config);
  const hookRefreshSeconds = resolveHookRefreshSeconds(config);
  resolveScanRules(config.scanRules, 'scanRules in config.json');
  const teams = Array.isArray(config.teams) ? config.teams : [];
  const seenNames = new Set();
  for (const team of teams) {
    if (!team || typeof team !== 'object' || typeof team.name !== 'string' || !team.name.trim()) {
      throw new Error('Each team in config.json must have a name');
    }
    if (seenNames.has(team.name)) throw new Error(`Duplicate team name "${team.name}" in config.json`);
    seenNames.add(team.name);
    if (typeof team.dir !== 'string' || !team.dir.trim()) {
      throw new Error(`Team ${team.name} is missing a valid dir`);
    }
    if (config.contextDir && pathsOverlap(team.dir, config.contextDir, gitFn, team.isolated ? { includePushTargets: true } : undefined)) {
      throw new Error(`Team ${team.name} dir cannot overlap the personal context repo`);
    }
    if (team.remotes !== undefined) {
      if (!Array.isArray(team.remotes)) throw new Error(`Team ${team.name}: remotes must be an array`);
      for (const r of team.remotes) {
        if (!parseRemote(r, { allowShorthand: true })) {
          throw new Error(`Team ${team.name} has an invalid remote matcher: ${redactUrl(String(r))}`);
        }
      }
    }
    if (team.namespaces !== undefined) {
      if (!Array.isArray(team.namespaces)) throw new Error(`Team ${team.name}: namespaces must be an array`);
      for (const ns of team.namespaces) {
        if (!parseNamespace(ns)) {
          throw new Error(`Team ${team.name} has an invalid namespace matcher: ${redactUrl(String(ns))}`);
        }
      }
    }
    if (team.isolated) {
      if (!hasScopeRules(team)) {
        throw new Error(`Isolated team ${team.name} must configure at least one remote or namespace`);
      }
      if (team.privateDir !== undefined && team.privateDir !== null) {
        if (typeof team.privateDir !== 'string' || !team.privateDir.trim()) {
          throw new Error(`Isolated team ${team.name} has an invalid privateDir`);
        }
        if (config.contextDir && pathsOverlap(team.privateDir, config.contextDir, gitFn, { includePushTargets: true })) {
          throw new Error(`Team ${team.name} privateDir cannot be or overlap the personal context repo`);
        }
        if (pathsOverlap(team.privateDir, team.dir, gitFn, { includePushTargets: true })) {
          throw new Error(`Team ${team.name} privateDir cannot be or overlap its shared team repo`);
        }
      }
    } else if (team.privateDir !== undefined && team.privateDir !== null) {
      throw new Error(`Team ${team.name} sets privateDir without isolated: true`);
    }
    resolveScanRules(team.scanRules, `teams[${team.name}].scanRules`);
    if (team.privateScanRules !== undefined) {
      if (!team.isolated || !team.privateDir) {
        throw new Error(`Team ${team.name} sets privateScanRules without privateDir`);
      }
      resolveScanRules(team.privateScanRules, `teams[${team.name}].privateScanRules`);
    }
  }

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i];
      const b = teams[j];
      const pairOpts = a.isolated || b.isolated ? { includePushTargets: true } : undefined;
      if (pathsOverlap(a.dir, b.dir, gitFn, pairOpts)) {
        throw new Error(`Teams ${a.name} and ${b.name} cannot share or overlap directories`);
      }
      if (a.privateDir && pathsOverlap(a.privateDir, b.dir, gitFn, { includePushTargets: true })) {
        throw new Error(`Team ${a.name} privateDir cannot overlap team ${b.name} repo`);
      }
      if (b.privateDir && pathsOverlap(b.privateDir, a.dir, gitFn, { includePushTargets: true })) {
        throw new Error(`Team ${b.name} privateDir cannot overlap team ${a.name} repo`);
      }
      if (a.privateDir && b.privateDir && pathsOverlap(a.privateDir, b.privateDir, gitFn, { includePushTargets: true })) {
        throw new Error(`Teams ${a.name} and ${b.name} cannot share or overlap privateDir`);
      }
    }
  }

  const isolatedTeams = teams.filter((t) => t.isolated);
  const personalAliases = validateAliases(config.aliases, 'aliases', isolatedTeams, null);
  const teamAliases = new Map();
  for (const team of teams) {
    teamAliases.set(team.name, validateAliases(team.aliases, `teams[${team.name}].aliases`, isolatedTeams, team));
  }
  return { mode, personalAliases, teamAliases, limits, staleSaveDays, hookRefreshSeconds };
}

export function validatePrivateDestination(config, team, gitFn) {
  if (!team.privateDir) {
    throw new Error(`Team ${team.name} has no privateDir configured`);
  }
  const allTeams = Array.isArray(config?.teams) ? config.teams : [];
  if (config?.contextDir && pathsOverlap(team.privateDir, config.contextDir, gitFn, { includePushTargets: true })) {
    throw new Error(`Team ${team.name} privateDir cannot be or overlap the personal context repo`);
  }
  if (pathsOverlap(team.privateDir, team.dir, gitFn, { includePushTargets: true })) {
    throw new Error(`Team ${team.name} privateDir cannot be or overlap its shared team repo`);
  }
  for (const other of allTeams) {
    if (other.name === team.name) continue;
    if (pathsOverlap(team.privateDir, other.dir, gitFn, { includePushTargets: true })) {
      throw new Error(`Team ${team.name} privateDir cannot overlap team ${other.name} repo`);
    }
    if (other.privateDir && pathsOverlap(team.privateDir, other.privateDir, gitFn, { includePushTargets: true })) {
      throw new Error(`Team ${team.name} privateDir cannot overlap team ${other.name} privateDir`);
    }
  }
  if (!existsSync(joinGit(team.privateDir))) {
    throw new Error(`Team ${team.name} privateDir is not an available git repository (${team.privateDir})`);
  }
  const workTree = gitFn(team.privateDir, ['rev-parse', '--is-inside-work-tree']);
  if (!workTree.ok || workTree.stdout.trim() !== 'true') {
    throw new Error(`Team ${team.name} privateDir is not a usable git work tree (${team.privateDir})`);
  }
  return team.privateDir;
}

function joinGit(dir) {
  return resolve(dir, '.git');
}
