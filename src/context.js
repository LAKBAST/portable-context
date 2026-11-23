import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasScopeRules,
  isCanonicalProjectId,
  isInsideDir,
  localProjectId,
  normalizeRealPath,
  parseRemote,
  redactText,
  redactUrl,
  remoteProjectId,
  slug,
  teamMatchesRemote,
  validateConfig,
  validatePrivateDestination,
} from './identity.js';
import { resolveScanRules, scanDiff } from './secrets.js';

export {
  hasScopeRules,
  parseRemote,
  redactText,
  redactUrl,
  remoteProjectId,
  slug,
  validateConfig,
  validatePrivateDestination,
};

const TEMPLATE_DIR = fileURLToPath(new URL('../template/', import.meta.url));
export const TEAM_TEMPLATE_DIR = fileURLToPath(new URL('../template-team/', import.meta.url));
const PULL_TIMEOUT = 15_000;
// The SessionStart hook times out at 30s; every pull and push in the hook must end before this.
const HOOK_BUDGET = 25_000;
const MIN_REFRESH_TIME = 2_000;
// Pull plus push must stay under the 30s SessionStart hook timeout.
const REFRESH_PUSH_TIMEOUT = 10_000;
const SYNC_PUSH_TIMEOUT = 60_000;
const CLONE_TIMEOUT = 120_000;
const PROFILE_MAX = 3000;
const PROJECT_MAX = 4000;
const DECISION_MAX = 1500;
const DECISIONS_INDEX_MAX_ITEMS = 20;
const DECISIONS_INDEX_MAX_CHARS = 1500;
const RECENT_SESSIONS = 3;

export function configDir() {
  return process.env.PCTX_HOME || join(os.homedir(), '.pctx');
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

function copyTemplate(dir, templateDir) {
  for (const entry of readdirSync(templateDir)) {
    // npm can drop files named .gitignore from packages, hence the rename.
    const target = join(dir, entry === 'gitignore' ? '.gitignore' : entry);
    if (!existsSync(target)) cpSync(join(templateDir, entry), target, { recursive: true });
  }
}

function seedEmptyRepo(dir, templateDir) {
  copyTemplate(dir, templateDir);
  const steps = [
    ['checkout', '-q', '-B', 'main'],
    ['add', '-A'],
    [...identityArgs(dir), 'commit', '-q', '-m', 'context: initialize'],
    ['push', '-q', '-u', 'origin', 'main'],
  ];
  for (const args of steps) {
    const result = git(dir, args, { timeout: SYNC_PUSH_TIMEOUT });
    if (!result.ok) {
      throw new Error(`Could not seed ${dir}: ${redactText(firstLine(result.stderr) || firstLine(result.stdout))}`);
    }
  }
}

export function setupContextRepo(url, dir, templateDir = TEMPLATE_DIR) {
  const target = resolve(dir);
  const safeUrl = redactUrl(url);
  if (existsSync(join(target, '.git'))) {
    const origin = git(target, ['config', '--get', 'remote.origin.url']).stdout.trim();
    const safeOrigin = origin ? redactUrl(origin) : '(none)';
    if (origin !== url) {
      throw new Error(
        `${target} already has origin ${safeOrigin}, expected ${safeUrl}. If the repo moved, run: git -C "${target}" remote set-url origin ${safeUrl}`,
      );
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    const clone = git(dirname(target), ['clone', '-q', '--', url, target], { timeout: CLONE_TIMEOUT });
    if (!clone.ok) throw new Error(`Could not clone ${safeUrl}: ${redactText(firstLine(clone.stderr))}`);
  }
  if (git(target, ['rev-parse', '--verify', '-q', 'HEAD']).ok) return { seeded: false };
  seedEmptyRepo(target, templateDir);
  return { seeded: true };
}

function rebaseInProgress(dir) {
  return existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'));
}

function stashCount(dir) {
  return git(dir, ['stash', 'list']).stdout.split('\n').filter(Boolean).length;
}

function currentBranch(dir) {
  const res = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return res.ok ? res.stdout.trim() : '';
}

function pullRebase(dir, timeout = PULL_TIMEOUT, { isolated = false } = {}) {
  const stashed = stashCount(dir);
  const branch = isolated ? currentBranch(dir) : '';
  const pullArgs = branch
    ? ['pull', '-q', '--rebase', '--autostash', 'origin', branch]
    : ['pull', '-q', '--rebase', '--autostash'];
  // Replaying local commits needs a committer identity too.
  const pull = git(dir, [...identityArgs(dir), ...pullArgs], { timeout });
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
  return { ok: false, message: `Could not pull: ${redactText(firstLine(pull.stderr)) || 'git pull failed'}` };
}

function aheadCount(dir, { isolated = false } = {}) {
  if (isolated) {
    const branch = currentBranch(dir);
    if (branch) {
      const originAhead = git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]);
      if (originAhead.ok) return Number(originAhead.stdout.trim()) || 0;
    }
  }
  const result = git(dir, ['rev-list', '--count', '@{u}..HEAD']);
  return result.ok ? Number(result.stdout.trim()) || 0 : 0;
}

function push(dir, timeout, { isolated = false } = {}) {
  const args = isolated
    ? (() => {
        const branch = currentBranch(dir);
        return ['-c', 'remote.pushDefault=origin', 'push', '-q', 'origin', ...(branch ? [branch] : [])];
      })()
    : ['push', '-q'];
  const result = git(dir, args, { timeout });
  if (result.ok) return { ok: true };
  return { ok: false, message: `Could not push: ${redactText(firstLine(result.stderr)) || 'git push failed'}` };
}

// `deadline` (a Date.now() value) shortens the git timeouts so several repos fit in one hook run.
export function refresh(dir, deadline = Infinity, { isolated = false } = {}) {
  const left = () => deadline - Date.now();
  if (left() < MIN_REFRESH_TIME) return { ok: false, message: 'Not refreshed: no time left in the session hook' };
  const pulled = pullRebase(dir, Math.min(PULL_TIMEOUT, left()), { isolated });
  if (!pulled.ok) return { ok: false, message: pulled.message };
  // Retries saves that could not be pushed earlier, for example while offline.
  if (aheadCount(dir, { isolated }) > 0) {
    if (left() < MIN_REFRESH_TIME) return { ok: false, message: 'Pending saves not pushed: no time left in the session hook' };
    const pushed = push(dir, Math.min(REFRESH_PUSH_TIMEOUT, left()), { isolated });
    if (!pushed.ok) return pushed;
  }
  return { ok: true };
}

export function hookDeadline(start = Date.now()) {
  return start + HOOK_BUDGET;
}

// ---------------------------------------------------------------- teams & scope

export function teamList(config) {
  return Array.isArray(config?.teams) ? config.teams : [];
}

export function defaultTeamDir(name) {
  return join(configDir(), 'teams', slug(name));
}

export function findTeam(config, name) {
  return teamList(config).find((team) => team.name === slug(name)) ?? null;
}

function teamProjectFile(team, project) {
  return join(team.dir, 'projects', `${project}.md`);
}

function remoteName(url) {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop();
  return last.replace(/\.git$/i, '');
}

function remoteBasenameFromParsed(parsed) {
  const seg = parsed.path.split('/').filter(Boolean).pop() ?? '';
  return slug(seg);
}

function projectFilesIn(dir) {
  return markdownFiles(join(dir, 'projects')).map((f) => f.slice(0, -3));
}

function findTeamByProjectFile(teams, projectId) {
  if (!projectId) return { team: null };
  const owners = teams.filter((team) => existsSync(teamProjectFile(team, projectId)));
  if (owners.length > 1) {
    const names = owners.map((team) => team.name).join(', ');
    return {
      team: null,
      conflict: `Project ${projectId} has notes in more than one team (${names}); keep projects/${projectId}.md in only one team repo`,
    };
  }
  return { team: owners[0] ?? null };
}

// Legacy helper preserved for direct callers.
export function resolveProjectTeam(config, project) {
  return findTeamByProjectFile(teamList(config).filter((t) => !t.isolated), project);
}

export function shareProject(config, team, project) {
  const teams = teamList(config);
  const { team: owner, conflict } = findTeamByProjectFile(teams, project);
  if (conflict) throw new Error(conflict);
  if (owner && owner.name !== team.name) throw new Error(`Project ${project} is already shared in team ${owner.name}`);
  const file = teamProjectFile(team, project);
  if (existsSync(file)) return { file, created: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${project}\n\nShared notes for the team. Keep only the current state of the project.\n`);
  return { file, created: true };
}

function findAliasForCanonical(aliasEntries, canonical) {
  return aliasEntries.find((a) => a.canonical === canonical)?.key ?? null;
}

function findAliasByKey(aliasEntries, rawKey) {
  return aliasEntries.find((a) => a.key === rawKey || a.key === slug(rawKey)) ?? null;
}

function matchingScopeTeams(teams, parsedRemote) {
  return teams.filter((team) => teamMatchesRemote(team, parsedRemote));
}

function inspectCwd(config, cwd) {
  if (!cwd || !existsSync(cwd)) return { exists: false };
  const teams = teamList(config);
  let ownerTeam = null;
  for (const team of teams) {
    if (isInsideDir(cwd, team.dir) || (team.privateDir && isInsideDir(cwd, team.privateDir))) {
      ownerTeam = team;
      break;
    }
  }
  const originRes = git(cwd, ['config', '--get', 'remote.origin.url']);
  const rawOrigin = originRes.ok ? originRes.stdout.trim() : '';
  let parsedOrigin = null;
  if (rawOrigin) {
    parsedOrigin = parseRemote(rawOrigin);
  }
  const topRes = git(cwd, ['rev-parse', '--show-toplevel']);
  const folderName = topRes.ok && topRes.stdout.trim() ? basename(topRes.stdout.trim()) : basename(resolve(cwd));
  return { exists: true, ownerTeam, rawOrigin, parsedOrigin, folderName };
}

function checkIsolatedProjectCollision(config, projectValue, isolatedTeams) {
  const bare = slug(projectValue);
  for (const team of isolatedTeams) {
    if (team.name === bare) return team;
    for (const stem of projectFilesIn(team.dir)) {
      if (stem === projectValue || stem === bare) return team;
    }
    if (team.privateDir && existsSync(team.privateDir)) {
      for (const stem of projectFilesIn(team.privateDir)) {
        if (stem === projectValue || stem === bare) return team;
      }
    }
    for (const raw of team.remotes ?? []) {
      const parsed = parseRemote(raw, { allowShorthand: true });
      if (parsed && remoteBasenameFromParsed(parsed) === bare) return team;
    }
    for (const key of Object.keys(team.aliases ?? {})) {
      if (key === projectValue || slug(key) === bare) return team;
    }
  }
  return null;
}

function validateSafeProjectArg(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Invalid --project value');
  if (/[\x00-\x1f\x7f]/.test(raw) || raw.trim() === '.' || raw.trim() === '..') {
    throw new Error(`Invalid --project value "${raw}"`);
  }
}

function resolveRemoteScope(teams, parsed, validated, allowConflict) {
  const scopeMatches = matchingScopeTeams(teams, parsed);
  if (scopeMatches.length > 1) {
    const involvesIsolated = scopeMatches.some((t) => t.isolated);
    const msg = `Ambiguous team scope for ${parsed.canonical} (matches teams: ${scopeMatches.map((t) => t.name).join(', ')})`;
    if (allowConflict) return { conflict: msg, team: null, isolatedTeam: null, isolatedConflict: involvesIsolated };
    throw new Error(msg);
  }
  const scopeTeam = scopeMatches[0] ?? null;
  if (!scopeTeam) {
    const isolatedCaseMatches = teams.filter(
      (t) => t.isolated && teamMatchesRemote(t, parsed, { caseInsensitivePath: true }),
    );
    if (isolatedCaseMatches.length) {
      const names = isolatedCaseMatches.map((t) => t.name).join(', ');
      const msg = `Remote ${parsed.canonical} differs only in path casing from isolated team scope (${names}); configure the exact canonical path or align the remote URL`;
      if (allowConflict) {
        return {
          conflict: msg,
          team: null,
          isolatedTeam: isolatedCaseMatches.length === 1 ? isolatedCaseMatches[0] : null,
          isolatedConflict: true,
        };
      }
      throw new Error(msg);
    }
  }
  if (scopeTeam?.isolated) {
    const id = remoteProjectId(parsed);
    const otherWithFile = teams.filter((t) => t.name !== scopeTeam.name && existsSync(teamProjectFile(t, id)));
    if (otherWithFile.length) {
      const msg = `Ambiguous project ${parsed.canonical}: matched team ${scopeTeam.name} but notes exist in ${otherWithFile.map((t) => t.name).join(', ')}`;
      if (allowConflict) return { conflict: msg, team: null, isolatedTeam: scopeTeam, isolatedConflict: true };
      throw new Error(msg);
    }
    return {
      team: scopeTeam,
      isolatedTeam: scopeTeam,
      id,
      display: parsed.canonical,
      alias: findAliasForCanonical(validated.teamAliases.get(scopeTeam.name) ?? [], parsed.canonical),
      isRemote: true,
    };
  }

  const useRemoteId = validated.mode === 'remote' || (scopeTeam && hasScopeRules(scopeTeam));
  const id = useRemoteId ? remoteProjectId(parsed) : slug(remoteBasenameFromParsed(parsed));
  const nonIsolated = teams.filter((t) => !t.isolated);
  const { team: fileTeam, conflict } = findTeamByProjectFile(nonIsolated, id);
  if (conflict) {
    if (allowConflict) return { conflict, team: null, isolatedTeam: null };
    throw new Error(conflict);
  }
  if (scopeTeam && fileTeam && scopeTeam.name !== fileTeam.name) {
    const msg = `Ambiguous project ${parsed.canonical}: scope matches ${scopeTeam.name} but notes exist in ${fileTeam.name}`;
    if (allowConflict) return { conflict: msg, team: null, isolatedTeam: null };
    throw new Error(msg);
  }
  const resolvedTeam = scopeTeam ?? fileTeam;
  const alias = resolvedTeam
    ? findAliasForCanonical(validated.teamAliases.get(resolvedTeam.name) ?? [], parsed.canonical)
    : findAliasForCanonical(validated.personalAliases, parsed.canonical);
  return {
    team: resolvedTeam,
    isolatedTeam: null,
    id,
    display: useRemoteId ? parsed.canonical : null,
    alias,
    isRemote: true,
  };
}

export function resolveScope(config, { cwd, project, teamName, strictCwd = false, allowConflict = false } = {}) {
  const validated = validateConfig(config, git);
  const teams = teamList(config);
  const isolatedTeams = teams.filter((t) => t.isolated);
  const hasAnyScopedTeam = teams.some((t) => t.isolated || hasScopeRules(t));

  if (strictCwd && (!cwd || !existsSync(cwd))) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }

  const info = inspectCwd(config, cwd);
  if (info.rawOrigin && !info.parsedOrigin && (validated.mode === 'remote' || hasAnyScopedTeam)) {
    throw new Error(`Unusable or invalid origin remote URL in ${cwd}: ${redactUrl(info.rawOrigin)}`);
  }

  let cwdResolved = null;
  if (info.parsedOrigin) {
    cwdResolved = resolveRemoteScope(teams, info.parsedOrigin, validated, allowConflict);
    if (cwdResolved.conflict && allowConflict) {
      const isIsolated = Boolean(cwdResolved.isolatedTeam || cwdResolved.isolatedConflict || info.ownerTeam?.isolated);
      return {
        mode: validated.mode,
        scopeKind: isIsolated ? 'isolated' : 'personal',
        team: null,
        isolatedTeam: cwdResolved.isolatedTeam ?? null,
        projectId: null,
        display: null,
        alias: null,
        conflict: cwdResolved.conflict,
      };
    }
  }

  if (info.ownerTeam?.isolated) {
    if (cwdResolved?.team && cwdResolved.team.name !== info.ownerTeam.name) {
      throw new Error(`Ambiguous scope: ${cwd} is inside team ${info.ownerTeam.name} but remote matches ${cwdResolved.team.name}`);
    }
    if (!cwdResolved?.team) {
      cwdResolved = {
        team: info.ownerTeam,
        isolatedTeam: info.ownerTeam,
        id: info.parsedOrigin ? remoteProjectId(info.parsedOrigin) : localProjectId(info.ownerTeam.name),
        display: info.parsedOrigin ? info.parsedOrigin.canonical : info.ownerTeam.name,
        alias: null,
        isRemote: Boolean(info.parsedOrigin),
      };
    }
  }

  const cwdIsolated = cwdResolved?.isolatedTeam ?? null;

  // Explicit maintenance access from an unrelated cwd via --team <name>.
  if (teamName) {
    const target = findTeam(config, teamName);
    if (!target) throw new Error(`No team named ${slug(teamName)}`);
    if (cwdIsolated && cwdIsolated.name !== target.name) {
      throw new Error(`Current directory belongs to isolated team ${cwdIsolated.name}; cannot target team ${target.name}`);
    }
    if (cwdResolved?.team && !cwdResolved.team.isolated && cwdResolved.team.name !== target.name) {
      throw new Error(`Current directory belongs to team ${cwdResolved.team.name}; cannot target team ${target.name}`);
    }

    const scopeKind = target.isolated ? 'isolated' : 'personal';
    if (project === undefined) {
      if (cwdResolved?.team?.name === target.name) {
        return {
          mode: validated.mode,
          scopeKind,
          team: target,
          isolatedTeam: target.isolated ? target : null,
          projectId: cwdResolved.id,
          display: cwdResolved.display,
          alias: cwdResolved.alias,
          conflict: null,
        };
      }
      if (!target.isolated && info.exists && !hasScopeRules(target) && validated.mode === 'legacy') {
        const legacyId = info.parsedOrigin ? slug(remoteBasenameFromParsed(info.parsedOrigin)) : slug(info.folderName);
        return {
          mode: validated.mode,
          scopeKind: 'personal',
          team: target,
          isolatedTeam: null,
          projectId: legacyId,
          display: null,
          alias: null,
          conflict: null,
        };
      }
      return {
        mode: validated.mode,
        scopeKind,
        team: target,
        isolatedTeam: target.isolated ? target : null,
        projectId: null,
        display: null,
        alias: null,
        conflict: null,
      };
    }

    validateSafeProjectArg(project);
    const trimmed = project.trim();
    const parsedProj = parseRemote(trimmed, { allowShorthand: true });
    if (parsedProj) {
      const matched = matchingScopeTeams(teams, parsedProj);
      if (matched.length > 1) {
        throw new Error(`Ambiguous team scope for ${parsedProj.canonical} (matches teams: ${matched.map((t) => t.name).join(', ')})`);
      }
      if (matched.length === 1 && matched[0].name !== target.name) {
        throw new Error(`Project ${parsedProj.canonical} belongs to team ${matched[0].name}, not ${target.name}`);
      }
      if (target.isolated && !teamMatchesRemote(target, parsedProj)) {
        throw new Error(`Project ${parsedProj.canonical} is outside isolated team ${target.name}'s configured scope`);
      }
      const useRemoteId = validated.mode === 'remote' || target.isolated || hasScopeRules(target);
      const id = useRemoteId ? remoteProjectId(parsedProj) : slug(remoteBasenameFromParsed(parsedProj));
      return {
        mode: validated.mode,
        scopeKind,
        team: target,
        isolatedTeam: target.isolated ? target : null,
        projectId: id,
        display: useRemoteId ? parsedProj.canonical : null,
        alias: findAliasForCanonical(validated.teamAliases.get(target.name) ?? [], parsedProj.canonical),
        conflict: null,
      };
    }

    if (/[\\/:]/.test(trimmed)) throw new Error(`Invalid --project value "${trimmed}"`);
    const teamAlias = findAliasByKey(validated.teamAliases.get(target.name) ?? [], trimmed);
    if (teamAlias) {
      return {
        mode: validated.mode,
        scopeKind,
        team: target,
        isolatedTeam: target.isolated ? target : null,
        projectId: teamAlias.id,
        display: teamAlias.canonical,
        alias: teamAlias.key,
        conflict: null,
      };
    }
    const existsInTarget =
      existsSync(teamProjectFile(target, trimmed)) ||
      (target.privateDir && existsSync(join(target.privateDir, 'projects', `${trimmed}.md`)));
    if (isCanonicalProjectId(trimmed) && existsInTarget) {
      return {
        mode: validated.mode,
        scopeKind,
        team: target,
        isolatedTeam: target.isolated ? target : null,
        projectId: trimmed,
        display: trimmed,
        alias: null,
        conflict: null,
      };
    }
    if (target.isolated || validated.mode === 'remote' || hasScopeRules(target)) {
      throw new Error(
        `Cannot resolve project "${trimmed}" in team ${target.name}; pass a remote URL, canonical <host>/<path>, or existing project ID`,
      );
    }
    return {
      mode: validated.mode,
      scopeKind,
      team: target,
      isolatedTeam: null,
      projectId: slug(trimmed),
      display: null,
      alias: null,
      conflict: null,
    };
  }

  // Case A: cwd is inside an isolated team scope. Never cross out to personal or other teams.
  if (cwdIsolated) {
    if (project !== undefined) {
      validateSafeProjectArg(project);
      const trimmed = project.trim();
      const parsedProj = parseRemote(trimmed, { allowShorthand: true });
      if (parsedProj) {
        const matched = matchingScopeTeams(teams, parsedProj);
        if (matched.length > 1) {
          throw new Error(`Ambiguous team scope for ${parsedProj.canonical} (matches teams: ${matched.map((t) => t.name).join(', ')})`);
        }
        if (!teamMatchesRemote(cwdIsolated, parsedProj)) {
          throw new Error(`Cannot target ${parsedProj.canonical} from isolated team ${cwdIsolated.name}`);
        }
        return {
          mode: validated.mode,
          scopeKind: 'isolated',
          team: cwdIsolated,
          isolatedTeam: cwdIsolated,
          projectId: remoteProjectId(parsedProj),
          display: parsedProj.canonical,
          alias: findAliasForCanonical(validated.teamAliases.get(cwdIsolated.name) ?? [], parsedProj.canonical),
          conflict: null,
        };
      }
      if (/[\\/:]/.test(trimmed)) throw new Error(`Invalid --project value "${trimmed}"`);
      if (trimmed === cwdResolved.id) {
        return {
          mode: validated.mode,
          scopeKind: 'isolated',
          team: cwdIsolated,
          isolatedTeam: cwdIsolated,
          projectId: cwdResolved.id,
          display: cwdResolved.display,
          alias: cwdResolved.alias,
          conflict: null,
        };
      }
      const teamAlias = findAliasByKey(validated.teamAliases.get(cwdIsolated.name) ?? [], trimmed);
      if (teamAlias) {
        return {
          mode: validated.mode,
          scopeKind: 'isolated',
          team: cwdIsolated,
          isolatedTeam: cwdIsolated,
          projectId: teamAlias.id,
          display: teamAlias.canonical,
          alias: teamAlias.key,
          conflict: null,
        };
      }
      throw new Error(
        `Cannot use bare project name "${trimmed}" in isolated team ${cwdIsolated.name}; omit --project to use the current repo or pass a remote matching ${cwdIsolated.name}`,
      );
    }
    return {
      mode: validated.mode,
      scopeKind: 'isolated',
      team: cwdIsolated,
      isolatedTeam: cwdIsolated,
      projectId: cwdResolved.id,
      display: cwdResolved.display,
      alias: cwdResolved.alias,
      conflict: null,
    };
  }

  // Case B: personal or non-isolated team scope.
  if (project !== undefined) {
    validateSafeProjectArg(project);
    const trimmed = project.trim();
    const parsedProj = parseRemote(trimmed, { allowShorthand: true });
    if (parsedProj) {
      const resolvedProj = resolveRemoteScope(teams, parsedProj, validated, allowConflict);
      if (resolvedProj.conflict && allowConflict) {
        const isIsolated = Boolean(resolvedProj.isolatedTeam || resolvedProj.isolatedConflict);
        return {
          mode: validated.mode,
          scopeKind: isIsolated ? 'isolated' : 'personal',
          team: null,
          isolatedTeam: resolvedProj.isolatedTeam ?? null,
          projectId: null,
          display: null,
          alias: null,
          conflict: resolvedProj.conflict,
        };
      }
      if (resolvedProj.isolatedTeam || resolvedProj.isolatedConflict) {
        throw new Error(
          resolvedProj.conflict ??
            `Project ${parsedProj.canonical} belongs to isolated team ${resolvedProj.isolatedTeam.name}; run inside that repo with --cwd or pass --team ${resolvedProj.isolatedTeam.name}`,
        );
      }
      return {
        mode: validated.mode,
        scopeKind: 'personal',
        team: resolvedProj.team,
        isolatedTeam: null,
        projectId: resolvedProj.id,
        display: resolvedProj.display,
        alias: resolvedProj.alias,
        conflict: resolvedProj.conflict ?? null,
      };
    }

    if (/[\\/:]/.test(trimmed)) throw new Error(`Invalid --project value "${trimmed}"`);
    const isolatedHit = checkIsolatedProjectCollision(config, trimmed, isolatedTeams);
    if (isolatedHit) {
      throw new Error(
        `Project "${trimmed}" matches isolated team ${isolatedHit.name}; pass --cwd inside that repo or --team ${isolatedHit.name}`,
      );
    }

    if (validated.mode === 'remote') {
      const aliasEntry = findAliasByKey(validated.personalAliases, trimmed);
      if (aliasEntry) {
        const { team: fileTeam, conflict } = findTeamByProjectFile(
          teams.filter((t) => !t.isolated),
          aliasEntry.id,
        );
        if (conflict) throw new Error(conflict);
        return {
          mode: validated.mode,
          scopeKind: 'personal',
          team: fileTeam,
          isolatedTeam: null,
          projectId: aliasEntry.id,
          display: aliasEntry.canonical,
          alias: aliasEntry.key,
          conflict: null,
        };
      }
      if (isCanonicalProjectId(trimmed)) {
        const nonIsolated = teams.filter((t) => !t.isolated);
        const { team: fileTeam, conflict } = findTeamByProjectFile(nonIsolated, trimmed);
        if (conflict) throw new Error(conflict);
        const inPersonal = existsSync(join(config.contextDir, 'projects', `${trimmed}.md`));
        if (fileTeam || inPersonal) {
          return {
            mode: validated.mode,
            scopeKind: 'personal',
            team: fileTeam,
            isolatedTeam: null,
            projectId: trimmed,
            display: trimmed,
            alias: null,
            conflict: null,
          };
        }
      }
      throw new Error(
        `In remote identity mode, --project "${trimmed}" requires a remote URL, canonical <host>/<path>, declared alias, or existing project ID`,
      );
    }

    const { team: fileTeam, conflict } = findTeamByProjectFile(
      teams.filter((t) => !t.isolated),
      slug(trimmed),
    );
    return {
      mode: validated.mode,
      scopeKind: 'personal',
      team: fileTeam,
      isolatedTeam: null,
      projectId: slug(trimmed),
      display: null,
      alias: null,
      conflict: conflict ?? null,
    };
  }

  if (cwdResolved) {
    return {
      mode: validated.mode,
      scopeKind: 'personal',
      team: cwdResolved.team,
      isolatedTeam: null,
      projectId: cwdResolved.id,
      display: cwdResolved.display,
      alias: cwdResolved.alias,
      conflict: null,
    };
  }

  if (!info.exists) {
    return {
      mode: validated.mode,
      scopeKind: 'personal',
      team: null,
      isolatedTeam: null,
      projectId: null,
      display: null,
      alias: null,
      conflict: null,
    };
  }

  const id = validated.mode === 'remote' ? localProjectId(info.folderName) : slug(info.folderName);
  const nonIsolated = teams.filter((t) => !t.isolated);
  const { team: fileTeam, conflict } = findTeamByProjectFile(nonIsolated, id);
  return {
    mode: validated.mode,
    scopeKind: 'personal',
    team: fileTeam,
    isolatedTeam: null,
    projectId: id,
    display: validated.mode === 'remote' ? `local: ${info.folderName}` : null,
    alias: null,
    conflict: conflict ?? null,
  };
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

function resolveSafeSubdir(repoDir, subdir) {
  if (!repoDir) return null;
  const dir = join(repoDir, subdir);
  if (!existsSync(dir)) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!isInsideDir(dir, repoDir)) return null;
  if (normalizeRealPath(dir) === normalizeRealPath(repoDir)) return null;
  return dir;
}

function isSafeRepoFile(repoDir, file) {
  if (!existsSync(file)) return false;
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  return isInsideDir(file, repoDir);
}

function safeDecisionFiles(repoDir) {
  const dir = resolveSafeSubdir(repoDir, 'decisions');
  if (!dir) return { dir: null, files: [] };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && isSafeRepoFile(repoDir, join(dir, name)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { dir, files };
}

function decisionsIndexSection(repos) {
  const buckets = [];
  let total = 0;
  for (const repo of repos) {
    const { dir: decisionsDir, files } = safeDecisionFiles(repo.dir);
    if (!files.length) continue;
    buckets.push({
      label: repo.label,
      decisionsDir,
      items: files.map((name) => ({
        name,
        line: `- ${name} (${repo.label}: ${join(decisionsDir, name)})`,
      })),
    });
    total += files.length;
  }
  if (!total) return [];

  // Round-robin across repos within both item and character budgets so one repo cannot starve another.
  const selectedByBucket = buckets.map(() => []);
  let selectedCount = 0;
  let usedChars = 0;
  let cursor = 0;
  let budgetFull = false;
  while (!budgetFull && selectedCount < DECISIONS_INDEX_MAX_ITEMS && selectedCount < total) {
    let addedInRound = false;
    for (let i = 0; i < buckets.length && selectedCount < DECISIONS_INDEX_MAX_ITEMS; i++) {
      if (cursor >= buckets[i].items.length) continue;
      const item = buckets[i].items[cursor];
      const nextChars = usedChars + (selectedCount ? 1 : 0) + item.line.length;
      if (selectedCount > 0 && nextChars > DECISIONS_INDEX_MAX_CHARS) {
        budgetFull = true;
        break;
      }
      selectedByBucket[i].push(item);
      selectedCount += 1;
      usedChars = nextChars;
      addedInRound = true;
    }
    if (!addedInRound) break;
    cursor += 1;
  }

  const lines = selectedByBucket.flatMap((items) => items.map((item) => item.line));
  const omittedDirs = [];
  let omitted = 0;
  for (let i = 0; i < buckets.length; i++) {
    const missing = buckets[i].items.length - selectedByBucket[i].length;
    if (missing > 0) {
      omitted += missing;
      omittedDirs.push(buckets[i].decisionsDir);
    }
  }
  if (omitted > 0) {
    lines.push(`- ... (${omitted} more; browse ${omittedDirs.join(', ')})`);
  }
  return [`## Decisions\n\n${lines.join('\n')}`];
}

function readScopedMarkdown(dir, subdir, projectId, alias, { checkInside = false } = {}) {
  const baseDir = checkInside ? resolveSafeSubdir(dir, subdir) : join(dir, subdir);
  if (!baseDir) {
    return {
      primaryFile: join(dir, subdir, `${projectId}.md`),
      primaryText: null,
      aliasFile: null,
      aliasText: null,
    };
  }
  const primaryFile = join(baseDir, `${projectId}.md`);
  const primaryText = !checkInside || isSafeRepoFile(dir, primaryFile) ? readIfExists(primaryFile) : null;
  const aliasFile = alias && alias !== projectId ? join(baseDir, `${alias}.md`) : null;
  const aliasText = aliasFile && (!checkInside || isSafeRepoFile(dir, aliasFile)) ? readIfExists(aliasFile) : null;
  return { primaryFile, primaryText, aliasFile, aliasText };
}

function formatScopedBody({ primaryFile, primaryText, aliasFile, aliasText }, maxChars, label, emptyText = null) {
  if (primaryText && aliasText) {
    return `${truncate(primaryText, maxChars, primaryFile)}\n\n### Legacy alias ${label} (${aliasFile})\n\n${truncate(aliasText, maxChars, aliasFile)}`;
  }
  if (primaryText) return truncate(primaryText, maxChars, primaryFile);
  if (aliasText) {
    return `(Loaded from declared alias ${aliasFile}; new ${label} use ${primaryFile}.)\n\n${truncate(aliasText, maxChars, aliasFile)}`;
  }
  return emptyText;
}

function projectDecisionSections(repos, projectId, alias, decisionMax = DECISION_MAX) {
  if (!projectId) return [];
  const sections = [];
  for (const repo of repos) {
    const data = readScopedMarkdown(repo.dir, 'decisions', projectId, alias, { checkInside: true });
    const body = formatScopedBody(data, decisionMax, 'decisions');
    if (body) sections.push(`## ${repo.heading}\n\n${body}`);
  }
  return sections;
}

function profileSection(dir, heading = 'Profile') {
  const file = join(dir, 'AGENTS.md');
  const text = readIfExists(file);
  return text ? [`## ${heading}\n\n${truncate(text, PROFILE_MAX, file)}`] : [];
}

function projectSection(dir, projectId, display, alias) {
  if (!projectId) return [];
  const header = `## Current project: ${projectId}`;
  const remoteLine = display && display !== projectId ? `Remote: ${display}\n\n` : '';
  const data = readScopedMarkdown(dir, 'projects', projectId, alias);
  const body = formatScopedBody(data, PROJECT_MAX, 'notes', `No notes yet (${data.primaryFile}).`);
  return [`${header}\n\n${remoteLine}${body}`];
}

function teamProjectSections(privateDir, team, projectId, display, alias, { includePrivate = true } = {}) {
  const data = readScopedMarkdown(team.dir, 'projects', projectId, alias);
  const sections = [];
  const teamProfile = readIfExists(join(team.dir, 'AGENTS.md'));
  if (teamProfile) sections.push(`## Team ${team.name}\n\n${truncate(teamProfile, PROFILE_MAX, join(team.dir, 'AGENTS.md'))}`);
  const remoteLine = display && display !== projectId ? `Remote: ${display}\n\n` : '';
  const body = formatScopedBody(data, PROJECT_MAX, 'notes', `No notes yet (${data.primaryFile}).`);
  sections.push(
    `## Current project: ${projectId} (shared in team ${team.name})\n\n` +
      remoteLine +
      `Team repo: ${team.dir}. Everyone in the team reads its notes and sessions; save sessions of this project there.\n\n` +
      body,
  );
  if (includePrivate && privateDir) {
    const priv = readScopedMarkdown(privateDir, 'projects', projectId, alias);
    const privBody = formatScopedBody(priv, PROJECT_MAX, 'notes');
    if (privBody) sections.push(`## Your private notes for ${projectId}\n\n${privBody}`);
  }
  return sections;
}

function sessionMatchesProject(filename, projectId, alias) {
  const match = /^\d{4}-\d{2}-\d{2}-\d{4}-(.+)\.md$/.exec(filename);
  if (!match) return false;
  const rest = match[1];
  if (rest.startsWith(`${projectId}-`)) return true;
  if (alias && rest.startsWith(`${slug(alias)}-`)) return true;
  return false;
}

function recentSessions(dir, projectId, alias = null) {
  if (!projectId) return [];
  return markdownFiles(join(dir, 'sessions'))
    .filter((name) => sessionMatchesProject(name, projectId, alias))
    .slice(-RECENT_SESSIONS);
}

function warningLine(label, result) {
  if (!result || result.ok) return [];
  return [`WARNING: ${label} may be out of date (${result.message ?? 'sync failed'}). Tell the user.`];
}

function excludedNames(projectId, alias) {
  const excluded = new Set();
  if (projectId) excluded.add(`${projectId}.md`);
  if (alias) excluded.add(`${alias}.md`);
  return excluded;
}

function buildIsolatedContext(team, resolved, teamResults, privateResult) {
  const projectId = resolved.projectId;
  const excluded = excludedNames(projectId, resolved.alias);
  const others = markdownFiles(join(team.dir, 'projects')).filter((name) => !excluded.has(name));
  const privateUsable = Boolean(team.privateDir && !privateResult?.unusable);
  if (privateUsable) {
    for (const name of markdownFiles(join(team.privateDir, 'projects'))) {
      if (!excluded.has(name) && !others.includes(name)) others.push(`${name} (private)`);
    }
  }
  const teamSessions = recentSessions(team.dir, projectId, resolved.alias);
  const privateSessions = privateUsable ? recentSessions(team.privateDir, projectId, resolved.alias) : [];
  const decisionRepos = [
    { label: `team ${team.name}`, dir: team.dir, heading: `Team ${team.name} decisions for ${projectId}` },
    ...(privateUsable
      ? [{ label: `private ${team.name}`, dir: team.privateDir, heading: `Your private decisions for ${projectId}` }]
      : []),
  ];
  return [
    `# Portable context (team ${team.name})`,
    `Team repo: ${team.dir}`,
    ...(team.privateDir ? [`Private repo: ${team.privateDir}`] : []),
    ...warningLine(`team ${team.name}`, teamResults[team.name]),
    ...(team.privateDir ? warningLine(`private ${team.name}`, privateResult) : []),
    ...(privateUsable ? profileSection(team.privateDir, `Your private profile (team ${team.name})`) : []),
    ...teamProjectSections(team.privateDir, team, projectId, resolved.display, resolved.alias, {
      includePrivate: privateUsable,
    }),
    ...projectDecisionSections(decisionRepos, projectId, resolved.alias),
    ...listSection('Other projects', others),
    ...decisionsIndexSection(decisionRepos),
    ...listSection(`Recent team sessions for this project (${join(team.dir, 'sessions')})`, teamSessions),
    ...(privateUsable
      ? listSection(`Recent private sessions for this project (${join(team.privateDir, 'sessions')})`, privateSessions)
      : []),
  ].join('\n\n');
}

// `teamResults` maps a team name to the result of refreshing that team repo.
export function buildContext(config, cwd, syncResult, teamResults = {}, extra = {}) {
  const resolved = extra.resolved ?? resolveScope(config, { cwd, allowConflict: true });
  if (resolved.scopeKind === 'isolated' && resolved.isolatedTeam && !resolved.conflict) {
    return buildIsolatedContext(resolved.isolatedTeam, resolved, teamResults, extra.privateResult);
  }
  if (resolved.conflict && (resolved.scopeKind === 'isolated' || resolved.isolatedTeam)) {
    return `Portable context unavailable: ${resolved.conflict}`;
  }

  const dir = config.contextDir;
  const nonIsolatedTeams = teamList(config).filter((t) => !t.isolated);
  const projectId = resolved.projectId;
  const team = resolved.team;
  const excluded = excludedNames(projectId, resolved.alias);
  const others = markdownFiles(join(dir, 'projects')).filter((name) => !excluded.has(name));
  for (const t of nonIsolatedTeams) {
    for (const name of markdownFiles(join(t.dir, 'projects'))) {
      if (!excluded.has(name)) others.push(`${name} (team ${t.name})`);
    }
  }
  const teamHeader = nonIsolatedTeams.length
    ? [`Team repos: ${nonIsolatedTeams.map((t) => `${t.name} (${t.dir})`).join(', ')}`]
    : [];
  const teamSessions = team ? recentSessions(team.dir, projectId, resolved.alias) : [];
  const decisionIndexRepos = [
    { label: 'personal', dir },
    ...(team ? [{ label: `team ${team.name}`, dir: team.dir }] : []),
  ];
  const decisionAutoloadRepos = team
    ? [
        { dir: team.dir, heading: `Team ${team.name} decisions for ${projectId}` },
        { dir, heading: `Your private decisions for ${projectId}` },
      ]
    : [{ dir, heading: `Project decisions: ${projectId}` }];
  return [
    '# Portable context',
    `Context repo: ${dir}`,
    ...teamHeader,
    ...warningLine('the context', syncResult),
    ...nonIsolatedTeams.flatMap((t) => warningLine(`team ${t.name}`, teamResults[t.name])),
    ...(resolved.conflict ? [`WARNING: ${resolved.conflict}. Tell the user.`] : []),
    ...profileSection(dir),
    ...(team
      ? teamProjectSections(dir, team, projectId, resolved.display, resolved.alias)
      : projectSection(dir, projectId, resolved.display, resolved.alias)),
    ...projectDecisionSections(decisionAutoloadRepos, projectId, resolved.alias),
    ...listSection('Other projects', others),
    ...decisionsIndexSection(decisionIndexRepos),
    ...listSection('Recent sessions for this project', recentSessions(dir, projectId, resolved.alias)),
    ...listSection(`Recent team sessions for this project (${join(team?.dir ?? '', 'sessions')})`, teamSessions),
  ].join('\n\n');
}

// Sessions of a shared project go to its team repo and carry the author, so the team knows who wrote them.
export function sessionPath(config, project, now = new Date(), team = null, targetDir = null) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const device = slug(config.device);
  const proj = isCanonicalProjectId(project) ? project : slug(project);
  if (team && !targetDir) {
    const author = slug(config.author ?? device);
    const who = author === device ? author : `${author}-${device}`;
    return join(team.dir, 'sessions', `${date}-${time}-${proj}-${who}.md`);
  }
  return join(targetDir ?? config.contextDir, 'sessions', `${date}-${time}-${proj}-${device}.md`);
}

function repoScanRulesForDir(config, dir) {
  if (!config || !dir) return [];
  const target = normalizeRealPath(dir);
  if (config.contextDir && normalizeRealPath(config.contextDir) === target) {
    return config.scanRules ?? [];
  }
  for (const team of teamList(config)) {
    if (team.dir && normalizeRealPath(team.dir) === target) return team.scanRules ?? [];
    if (team.privateDir && normalizeRealPath(team.privateDir) === target) return team.privateScanRules ?? [];
  }
  return [];
}

export function stagedFindings(dir, { rules = [] } = {}) {
  const resolvedRules = resolveScanRules(rules, 'scanRules');
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${redactText(firstLine(add.stderr))}`);
  // --text and the fixed prefixes keep user config and .gitattributes from hiding content from the scan.
  const diff = git(dir, [
    '-c', 'core.quotepath=off',
    'diff', '--cached', '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/',
  ]);
  if (!diff.ok) throw new Error(`git diff failed: ${redactText(firstLine(diff.stderr))}`);
  return scanDiff(diff.stdout, { rules: resolvedRules });
}

function commitStaged(dir, message) {
  if (!git(dir, ['status', '--porcelain']).stdout.trim()) return { committed: false };
  const commit = git(dir, [...identityArgs(dir), 'commit', '-q', '-m', message]);
  if (commit.ok) return { committed: true };
  return {
    committed: false,
    error: redactText(firstLine(commit.stderr) || firstLine(commit.stdout)) || 'git commit failed',
  };
}

export function sync(config, message, dir = config.contextDir, { isolated = false, rules } = {}) {
  let resolvedRules;
  try {
    resolvedRules = resolveScanRules(rules !== undefined ? rules : repoScanRulesForDir(config, dir), 'scanRules');
  } catch (err) {
    return { status: 'error', message: err.message };
  }
  let findings;
  try {
    findings = stagedFindings(dir, { rules: resolvedRules });
  } catch (err) {
    return { status: 'error', message: err.message };
  }
  if (findings.length) {
    git(dir, ['reset', '-q']);
    return { status: 'blocked', findings };
  }

  const { committed, error } = commitStaged(dir, message || `context: update from ${config.device}`);
  if (error) return { status: 'error', message: error };

  const pulled = pullRebase(dir, PULL_TIMEOUT, { isolated });
  if (!pulled.ok) return { status: 'local-only', message: pulled.message, committed };

  const ahead = aheadCount(dir, { isolated });
  if (ahead > 0) {
    const pushed = push(dir, SYNC_PUSH_TIMEOUT, { isolated });
    if (!pushed.ok) return { status: 'local-only', message: pushed.message, committed };
  }
  return { status: committed || ahead > 0 ? 'synced' : 'up-to-date', committed };
}
