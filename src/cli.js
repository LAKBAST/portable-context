import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildContext,
  configDir,
  defaultDevice,
  detectProject,
  git,
  loadConfig,
  refresh,
  saveConfig,
  sessionPath,
  setupContextRepo,
  slug,
  stagedFindings,
  sync,
} from './context.js';
import { install, removeSkill, status, uninstall } from './integrations.js';

const DEFAULT_SKILL = 'save-context';

const USAGE = `Usage: pctx <command> [options]

Commands:
  setup <git-url> [--dir <path>] [--device <name>] [--skill-name <name>]
                 Clone or seed the context repo and install the integrations
  install        Install the hook and skill for Claude Code, Codex and Antigravity
  uninstall      Remove the hook and skill (never touches the context repo)
  doctor         Show device, context repo and integration state
  hook [--format antigravity]
                 SessionStart hook: pull and print the context
  session-path [--project <name>] [--cwd <path>]
                 Print the path for a new session summary
  sync [-m <message>]
                 Scan for secrets, commit, pull and push
  scan           Scan pending changes for secrets without committing`;

const OPTIONS = {
  dir: { type: 'string' },
  device: { type: 'string' },
  'skill-name': { type: 'string' },
  project: { type: 'string' },
  cwd: { type: 'string' },
  message: { type: 'string', short: 'm' },
  help: { type: 'boolean', short: 'h' },
};

function requireConfig() {
  const config = loadConfig();
  if (!config) throw new Error('Not configured. Run: pctx setup <git-url>');
  return config;
}

function formatFindings(findings) {
  return findings.map(({ file, line, rule }) => `${file}:${line} (${rule})`).join('\n');
}

function printInstalled(names) {
  if (!names.length) {
    console.log('No Claude Code, Codex or Antigravity was found on this device; no hook or skill installed.');
    return;
  }
  console.log(`Installed for: ${names.join(', ')}`);
  if (names.includes('codex')) console.log('Codex: approve the new hook with /hooks in Codex.');
  if (names.includes('antigravity')) console.log('Antigravity: the portable-context plugin loads in new conversations.');
}

function runSetup(positionals, values) {
  const url = positionals[0];
  if (!url) throw new Error('Usage: pctx setup <git-url> [--dir <path>] [--device <name>] [--skill-name <name>]');
  const previous = loadConfig();
  const config = {
    contextDir: resolve(values.dir ?? previous?.contextDir ?? join(configDir(), 'context')),
    device: slug(values.device ?? previous?.device ?? defaultDevice()),
    skillName: slug(values['skill-name'] ?? previous?.skillName ?? DEFAULT_SKILL),
  };
  const { seeded } = setupContextRepo(url, config.contextDir);
  // Saved only after install, so a refused install keeps the previous skill name.
  const installed = install(config);
  saveConfig(config);
  if (previous?.skillName && previous.skillName !== config.skillName) removeSkill(previous.skillName);
  console.log(`Context repo: ${config.contextDir}${seeded ? ' (seeded from the template)' : ''}`);
  console.log(`Device: ${config.device}`);
  printInstalled(installed);
  return 0;
}

function runInstall() {
  printInstalled(install(requireConfig()));
  return 0;
}

function runUninstall() {
  const removed = uninstall(loadConfig() ?? { skillName: DEFAULT_SKILL });
  console.log(removed.length ? `Removed from: ${removed.join(', ')}` : 'Nothing to remove.');
  return 0;
}

function redactUrl(url) {
  return url.replace(/\/\/[^/@\s]+@/, '//***@');
}

function runDoctor() {
  const config = requireConfig();
  const remote = git(config.contextDir, ['config', '--get', 'remote.origin.url']);
  console.log(`Device: ${config.device}`);
  console.log(`Context dir: ${config.contextDir}`);
  console.log(`Remote: ${remote.ok ? redactUrl(remote.stdout.trim()) : '(not found)'}`);
  const state = (on) => (on ? 'installed' : 'missing');
  for (const item of status(config)) {
    if (!item.available) {
      console.log(`${item.name}: not found on this device`);
      continue;
    }
    const problem = item.problem ? ` (${item.problem})` : '';
    console.log(`${item.name}: hook ${state(item.hook)}, skill ${state(item.skill)}${problem}`);
  }
  return 0;
}

function readHookInput() {
  try {
    if (process.stdin.isTTY) return {};
    const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
    return input && typeof input === 'object' ? input : {};
  } catch {
    return {};
  }
}

function hookWorkDir(input, antigravity) {
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd;
  // Antigravity sends the open workspaces and runs the hook inside the plugin folder.
  const [workspace] = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  if (typeof workspace === 'string' && workspace) return workspace;
  return antigravity ? homedir() : process.cwd();
}

// Antigravity reads a JSON object from stdout and shows injected steps to the model.
function printHookOutput(text, antigravity) {
  if (!antigravity) {
    if (text) console.log(text);
    return;
  }
  const steps = text ? [{ systemMessage: { systemMessage: text } }] : [];
  console.log(JSON.stringify(steps.length ? { injectSteps: steps } : {}));
}

// A session must start normally even when the context cannot be loaded, so this always returns 0.
function runHook(args) {
  const formatAt = args.indexOf('--format');
  const antigravity = formatAt !== -1 && args[formatAt + 1] === 'antigravity';
  let text = '';
  try {
    const config = loadConfig();
    if (config) {
      const workDir = hookWorkDir(readHookInput(), antigravity);
      text = buildContext(config, workDir, refresh(config.contextDir));
    }
  } catch (err) {
    text = `Portable context unavailable: ${String(err?.message ?? err).split(/\r?\n/)[0]}`;
  }
  printHookOutput(text, antigravity);
  return 0;
}

function runSessionPath(values) {
  const config = requireConfig();
  const project = values.project ?? detectProject(resolve(values.cwd ?? process.cwd())) ?? 'general';
  const file = sessionPath(config, project);
  mkdirSync(dirname(file), { recursive: true });
  console.log(file);
  return 0;
}

function runSync(values) {
  const result = sync(requireConfig(), values.message);
  if (result.status === 'synced' || result.status === 'up-to-date') {
    console.log(result.status);
    return 0;
  }
  if (result.status === 'blocked') {
    console.error(`blocked: possible secrets found, nothing was committed\n${formatFindings(result.findings)}`);
    return 2;
  }
  console.error(`${result.status}: ${result.message}`);
  return 1;
}

function runScan() {
  const { contextDir } = requireConfig();
  let findings;
  try {
    findings = stagedFindings(contextDir);
  } finally {
    git(contextDir, ['reset', '-q']);
  }
  if (!findings.length) {
    console.log('clean');
    return 0;
  }
  console.log(formatFindings(findings));
  return 2;
}

function dispatch(command, positionals, values) {
  switch (command) {
    case 'setup':
      return runSetup(positionals, values);
    case 'install':
      return runInstall();
    case 'uninstall':
      return runUninstall();
    case 'doctor':
      return runDoctor();
    case 'session-path':
      return runSessionPath(values);
    case 'sync':
      return runSync(values);
    case 'scan':
      return runScan();
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

export async function main(argv) {
  // Checked before parseArgs: a bad flag must not make the hook exit non-zero.
  if (argv[0] === 'hook') return runHook(argv.slice(1));
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [command, ...rest] = positionals;
    if (!command || values.help) {
      console.log(USAGE);
      return 0;
    }
    return dispatch(command, rest, values);
  } catch (err) {
    console.error(`pctx: ${err.message}`);
    return 1;
  }
}
