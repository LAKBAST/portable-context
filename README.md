# pctx (portable-context)

Your agent memories do not travel. What Claude Code learned on your laptop is not available to Codex on your desktop, or to a fresh terminal on another machine. `pctx` keeps one private git repository of markdown context and loads it into every Claude Code, Codex and Antigravity session, on every device.

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

Run these in a normal terminal, not as administrator or with `sudo`. Files created with elevated rights can make git refuse the repo later (`dubious ownership`).

```sh
git clone https://github.com/LAKBAST/portable-context.git "$HOME/.pctx/tool"
npm install -g "$HOME/.pctx/tool"
```

`npm install -g github:...` does not work on npm 12, which refuses git packages by default.

On Windows PowerShell, if scripts are disabled (`npm.ps1` cannot be loaded), use `npm.cmd` and `pctx.cmd` in every command here. You do not need to change the execution policy, and the hook and skill are not affected because they call `node` directly.

To update, run `git pull` in `$HOME/.pctx/tool`. The hook and skill point at this folder, so keep it in place.

## Create your context repo (once)

Create a private, empty repo, then point `pctx` at it:

```sh
gh repo create <you>/context --private
pctx setup https://github.com/<you>/context.git
```

If the repo is empty, `setup` seeds it with `AGENTS.md`, `README.md` and `.gitignore` and pushes to `main`. It then saves `~/.pctx/config.json` and installs the hook and skill for Claude Code, Codex and Antigravity. Only tools whose home directory exists (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`; `ANTIGRAVITY_CONFIG_DIR` or `~/.gemini/config`) are configured.

Options: `--dir <path>` (where to clone), `--device <name>` (appears in session file names), `--skill-name <name>` (default `save-context`).

## Add another device

Install `pctx` the same way, then run `pctx setup <same-url>`, with the same `--skill-name` if you changed it. The existing repo is cloned and its contents are used as is. The device name defaults to the computer's hostname; use `--device` only if two devices share one.

## Move the context repo

If the repo changes URL, update each device that already has it:

```sh
git -C "$HOME/.pctx/context" remote set-url origin <new-url>
```

## Approve the hook in Codex

Codex asks you to trust new hooks. Start Codex and run `/hooks` to review and approve the `pctx` SessionStart hook.

Codex's automatic approval review can also stop the save skill's `pctx sync`, because the notes it pushes may mention internal infrastructure and Codex does not know the remote is yours. `pctx` installs `~/.codex/rules/pctx.rules`, which allows exactly `node "<path>/bin/pctx.js" sync` and leaves every other command to the normal review. Restart Codex after installing so it loads the rule. `pctx` refuses to overwrite a `pctx.rules` it did not create.

## Antigravity

Antigravity loads hooks and skills from plugins, so `pctx` installs its own plugin at `~/.gemini/config/plugins/portable-context/` (`plugin.json`, `hooks.json` and `skills/<skill-name>/SKILL.md`). It runs `pctx hook --format antigravity` when a conversation starts and loads the project of the first open workspace. `pctx` owns that folder: it refuses to install over a `portable-context` plugin it did not create, and `uninstall` removes only its own files. MCP servers are not managed by `pctx`; add them to `~/.gemini/config/mcp_config.json` yourself.

## Save a session

- Claude Code: `/save-context`
- Codex: `$save-context`
- Antigravity: ask the agent to save the context; it picks the skill by its description.

The agent writes `sessions/YYYY-MM-DD-HHmm-<project>-<device>.md` (path from `pctx session-path`) and runs `pctx sync`.

## Edit your profile

Replace the template text in `AGENTS.md` inside your context repo (`~/.pctx/context` by default) with your own preferences, then run `pctx sync`. It is loaded in every session on every device, so keep it short.

## Work with other people (teams)

Your context repo stays private. To share context with other people, add a team: a second git repo that everyone in the team can read and push to. Each person keeps their own private repo, and only what is written into the team repo is shared. Access is whatever your git host grants on that repo; pctx has no server and no accounts.

Create a private, empty repo for the team and give the others access to it. Then, on each device of each person:

```sh
pctx team add <name> <git-url> --author <your-name>
```

The first `team add` seeds the repo with `AGENTS.md` (team conventions), `README.md` and `.gitignore`. The clone goes to `~/.pctx/teams/<name>` unless you pass `--dir`. `--author` (saved once for all teams, defaults to the device name) goes into the names of your team sessions so the team knows who wrote them.

Share a project by asking the agent in a session of that project (for example `/save-context comparte este proyecto con el team <name>`). The save skill runs `pctx team share`, writes into the team notes only what the team needs from your private notes, keeps the rest private, saves the session and syncs. By hand, run this inside the project's repo, edit the team notes and run `pctx sync`:

```sh
pctx team share <name>
```

When you save a shared project, the skill splits the session: what is useful to the team goes to the team repo, and anything that is not for the team (and anything it is unsure about) goes to a private session in your context repo, using `pctx session-path --private`. It then tells you what went where.

A project is shared when `projects/<project>.md` exists in a team repo. For a shared project:

- The hook also loads the team's `AGENTS.md`, the team notes for the project and the latest team sessions, from everyone.
- `pctx session-path` returns a path in the team repo, `sessions/YYYY-MM-DD-HHmm-<project>-<author>-<device>.md` (just `<author>` when it equals the device), so the save skill writes there.
- Notes for that project that were already in your private repo stay private and are shown only to you.

Your profile, your other projects and their sessions never go to a team repo. You can be in several teams, but a project can only belong to one: if two team repos have notes for the same project, the hook loads neither and warns you, and `session-path` refuses until you remove it from one of them.

`pctx sync` and `pctx scan` cover the context repo and every team; with teams, each output line starts with the repo (`context:` or `team <name>:`). `pctx team list` shows your teams and `pctx team remove <name>` stops loading one, leaving its clone in place.

## Commands

| Command | What it does |
| --- | --- |
| `pctx setup <git-url> [--dir] [--device] [--author] [--skill-name]` | Clone (and seed if empty) the context repo, save config, install hook and skill |
| `pctx team add <name> <git-url> [--dir] [--author]` | Clone (and seed if empty) a team repo and add it to the config |
| `pctx team share <name> [--project] [--cwd]` | Share a project with a team by creating its notes in the team repo |
| `pctx team remove <name>` / `pctx team list` | Stop loading a team (its clone is kept) / list teams |
| `pctx install` | Install the hook and skill into Claude Code, Codex and Antigravity, and the Codex rule for `pctx sync` |
| `pctx uninstall` | Remove the hook, skill and Codex rule that pctx installed |
| `pctx doctor` | Check the configuration and installation |
| `pctx hook [--format antigravity]` | SessionStart hook: reads `{cwd}` (or Antigravity's `workspacePaths`) JSON on stdin, pulls, prints context (as `injectSteps` JSON with `--format antigravity`). Always exits 0 |
| `pctx session-path [--project] [--cwd] [--private]` | Print a new session file path and create `sessions/` (in the team repo for a shared project; `--private` always uses your context repo) |
| `pctx sync [-m]` | Scan, commit, pull and push the context repo and every team. Prints `synced` or `up-to-date` |
| `pctx scan` | Scan pending changes for secrets: `clean` or findings |

`sync` exit codes: 0 success; 2 a possible secret was found (nothing is committed in that repo, findings are listed as `file:line (rule)` without the value); 1 pull or push failed (`local-only: ...` on stderr, the commit is kept locally). With teams, the worst result of all repos sets the exit code.

Settings files are edited conservatively: other keys and hooks are preserved, invalid JSON is left unchanged and the command fails, the first change creates `<file>.pctx-backup`, and an existing `SKILL.md` that lacks `managed-by: portable-context` is never overwritten.

## What is synced, and what is not

Synced: the markdown in your context repo, and in each team repo you added. Nothing else leaves your machine. There is no pctx server; only you (and, for a team repo, the people with access to it) and your git host see the data. Use private repos.

Never synced: your agents' own settings, credentials, or transcripts. Only what is written into the context repo is pushed.

Secret scanning runs before each commit and blocks known token and private key patterns. It is a best-effort safety net, not a guarantee. Do not put secrets in your context.

## Limitations

- The mobile apps and claude.ai do not run hooks or local skills, so they cannot load or save context.
- Conflicting edits to the same file on two devices are not merged automatically; `sync` reports `local-only` and you resolve it in the context repo with git.
- If unsaved edits clash with newer changes when a session starts, they are moved to `git stash` and the agent is told to warn you. Run `git stash pop` in the context repo to get them back.
- Commit signing (`commit.gpgsign`) has not been tested and may make saves fail.

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

## License

[MIT](LICENSE)
