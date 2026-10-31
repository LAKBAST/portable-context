# pctx (portable-context)

Your agent memories do not travel. What Claude Code learned on your laptop is not available to Codex on your desktop, or to a fresh terminal on another machine. `pctx` keeps one private git repository of markdown context and loads it into every Claude Code and Codex session, on every device.

## How it works

- Your context lives in a git repo that you own (profile, per-project notes, saved sessions). `pctx setup` clones it to `~/.pctx/context` by default.
- A SessionStart hook runs `pctx hook`. It pulls the repo and prints the context into the new session: your profile (`AGENTS.md`), the notes for the current project, a list of other projects, and recent sessions for this project. The project is identified by the basename of the `origin` remote of the working directory, or by the folder name when there is no remote.
- A skill (`save-context`) lets the agent write a session summary into the repo and run `pctx sync`, which commits and pushes.
- If git cannot pull or push (offline, conflict), the hook still prints your local context, adds a `WARNING` line, and exits 0. Unpushed commits stay local and are pushed on a later sync or hook run.

## Requirements

- Node.js 20 or newer
- git, with credentials that can push to your context repo

No npm dependencies.

## Install

```sh
npm install -g github:LAKBAST/portable-context
```

## Create your context repo (once)

Create a private, empty repo, then point `pctx` at it:

```sh
gh repo create <you>/context --private
pctx setup https://github.com/<you>/context.git
```

If the repo is empty, `setup` seeds it with `AGENTS.md`, `README.md` and `.gitignore` and pushes to `main`. It then saves `~/.pctx/config.json` and installs the hook and skill for Claude Code and Codex. Only tools whose home directory exists (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`) are configured.

Options: `--dir <path>` (where to clone), `--device <name>` (appears in session file names), `--skill-name <name>` (default `save-context`).

## Add another device

Install `pctx` the same way, then run `pctx setup <same-url>` with a different `--device` name. The existing repo is cloned and its contents are used as is.

## Approve the hook in Codex

Codex asks you to trust new hooks. Start Codex and run `/hooks` to review and approve the `pctx` SessionStart hook.

## Save a session

- Claude Code: `/save-context`
- Codex: `$save-context`

The agent writes `sessions/YYYY-MM-DD-HHmm-<project>-<device>.md` (path from `pctx session-path`) and runs `pctx sync`.

## Commands

| Command | What it does |
| --- | --- |
| `pctx setup <git-url> [--dir] [--device] [--skill-name]` | Clone (and seed if empty) the context repo, save config, install hook and skill |
| `pctx install` | Install the hook and skill into Claude Code and Codex |
| `pctx uninstall` | Remove the hook and skill that pctx installed |
| `pctx doctor` | Check the configuration and installation |
| `pctx hook` | SessionStart hook: reads `{cwd}` JSON on stdin, pulls, prints context. Always exits 0 |
| `pctx session-path [--project] [--cwd]` | Print a new session file path and create `sessions/` |
| `pctx sync [-m]` | Scan, commit, pull and push. Prints `synced` or `up-to-date` |
| `pctx scan` | Scan pending changes for secrets: `clean` or findings |

`sync` exit codes: 0 success; 2 a possible secret was found (nothing is committed, findings are listed as `file:line (rule)` without the value); 1 pull or push failed (`local-only: ...` on stderr, the commit is kept locally).

Settings files are edited conservatively: other keys and hooks are preserved, invalid JSON is left unchanged and the command fails, the first change creates `<file>.pctx-backup`, and an existing `SKILL.md` that lacks `managed-by: portable-context` is never overwritten.

## What is synced, and what is not

Synced: the markdown in your context repo. Nothing else leaves your machine. There is no pctx server; only you and your git host see the data. Use a private repo.

Never synced: your agents' own settings, credentials, or transcripts. Only what is written into the context repo is pushed.

Secret scanning runs before each commit and blocks known token and private key patterns. It is a best-effort safety net, not a guarantee. Do not put secrets in your context.

## Limitations

- The mobile apps and claude.ai do not run hooks or local skills, so they cannot load or save context.
- Conflicting edits to the same file on two devices are not merged automatically; `sync` reports `local-only` and you resolve it in the context repo with git.

## Uninstall

```sh
pctx uninstall
npm uninstall -g @lakbast/portable-context
```

This removes the hook and skill. Your context repo and `~/.pctx` are left in place; delete them yourself if you want them gone.

## Tests

```sh
npm test
```
