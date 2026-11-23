# pctx (portable-context)

Your agent memories do not travel. What Claude Code learned on your laptop is not available to Codex on your desktop, or to a fresh terminal on another machine. `pctx` keeps one private git repository of markdown context and loads it into every Claude Code, Codex and Antigravity session, on every device.

## How it works

- Your context lives in a git repo that you own (profile, per-project notes, saved sessions). `pctx setup` clones it to `~/.pctx/context` by default.
- A SessionStart hook runs `pctx hook`. It pulls the repo and prints the context into the new session: your profile (`AGENTS.md`), the notes for the current project, a bounded index of `decisions/` in the active scope, any project decision at `decisions/<project-id>.md`, a list of other projects, and recent sessions for this project. By default (legacy mode), the project is identified by the basename of the `origin` remote of the working directory, or by the folder name when there is no remote; you can switch to host-and-full-path remote identity (`"projectIdentity": "remote"`) and configure isolated team scopes in `~/.pctx/config.json`.
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

Options: `--dir <path>` (where to clone), `--device <name>` (appears in session file names), `--skill-name <name>` (default `save-context`), `--project-identity <legacy|remote>` (default `legacy`).

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

Each saved session also gets a `## Working style` section about the person using pctx: how they asked for things, what they corrected, what annoyed them, how they decided, with short quotes of their own words. The title stays in English in every language so tools can find it. When the same pattern shows up in two or more sessions and your profile does not say it yet, the agent proposes the exact line to add to `AGENTS.md` (or the file it points to) and only changes it if you agree. Over time your profile learns how you work, for every agent and device. For a project shared with a team, this section goes to your private session, never to the team repo.

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

`pctx sync` and `pctx scan` cover the context repo and every non-isolated team; with teams, each output line starts with the repo (`context:` or `team <name>:`). `pctx team list` shows your teams and `pctx team remove <name>` stops loading one, leaving its clone in place.

## Project identity by remote (host + full path)

When two repositories share the same basename across different hosts or namespaces (for example `https://github.com/alex/api.git` and `https://git.acme.example/platform/api.git`), basename-only matching collides. Setting `"projectIdentity": "remote"` in `~/.pctx/config.json` (or passing `--project-identity remote` to `pctx setup`) identifies each project from its normalized `(host, full remote path)`:

- **HTTPS and SSH equivalence**: for default ports, `https://github.com/alex/api.git`, `https://github.com:443/alex/api.git`, `git@github.com:alex/api.git`, and `ssh://git@github.com:22/alex/api` all normalize to `github.com/alex/api`.
- **Ports and path casing preserved**: non-default ports (such as `https://git.acme.example:8443/org/api.git` vs `:9443` or `ssh://git@git.acme.example:2222/org/api.git`) and repository path capitalization (`Org/Repo` vs `org/repo`) stay distinct in the identity so arbitrary Git servers never merge separate repositories.
- **Nested paths**: subgroups like `https://git.acme.example/platform/billing/api.git` keep the full path `git.acme.example/platform/billing/api`.
- **Collision-free, path-safe filenames**: each remote maps to `<readable-slug>--<hash10>` (only `[a-z0-9-]`, bounded length for Windows and POSIX). Credentials in URLs are stripped before hashing and redacted from CLI output.
- **No-remote fallback**: folders without an `origin` remote resolve to `local--<folder-slug>`, which cannot collide with remote IDs. Windows drive paths (`C:\repos\app.git`) are treated as local paths rather than SSH `host:path`.

### Migrating existing personal projects without losing notes

In `"projectIdentity": "remote"` mode, `pctx` never guesses a project by basename, so notes in `projects/api.md` will not be loaded by another remote also named `api`. Declare explicit migration aliases in `~/.pctx/config.json` for known repositories using each remote's canonical path (`<host>[:<port>]/<Path>`, matching the repository's path casing and any non-default port if your provider requires an alias for differently cased URLs):

```json
{
  "contextDir": "/home/alex/.pctx/context",
  "device": "laptop",
  "skillName": "save-context",
  "projectIdentity": "remote",
  "aliases": {
    "api": "github.com/alex/api",
    "web-app": "https://github.com/alex/web-app.git"
  }
}
```

With an explicit alias, only the declared remote reads the existing `projects/<alias>.md` notes, `decisions/<alias>.md` decision file, and `sessions/*-<alias>-*.md` history while new sessions, notes, and decisions are written under the new remote ID. Alternatively, you can rename `projects/<old>.md` and `decisions/<old>.md` directly to `<new-id>.md` in your context repo and run `pctx sync`.

## Decisions index and project decisions

When `decisions/*.md` files exist in the repositories of the current project scope (your personal repo and the current project's non-isolated team, or an isolated team's shared and available private repos):

- **Bounded index**: `pctx hook` lists Markdown decision filenames together with their origin and navigable path under `## Decisions`, capped in stable order so the index never exceeds the context budget. Other decision files stay valid in the index without loading their bodies.
- **Project decision autoload**: `decisions/<project-id>.md` (and `decisions/<alias>.md` when an explicit migration alias matches the current remote) is loaded automatically for the current project, separated per repository without mixing repos or guessing ambiguous short names.
- **Symlink safety**: symlinks or junctions pointing outside the repository (including a `decisions/` directory linked to another scope) are ignored.

### Configurable per-file limits

You can override the character truncation limits per loaded file in `~/.pctx/config.json`:

```json
{
  "limits": {
    "profile": 3000,
    "project": 4000,
    "decision": 1500
  }
}
```

- `profile` (default `3000`): applies to personal, team, and isolated private `AGENTS.md` files.
- `project` (default `4000`): applies to personal, team, and private `projects/<id>.md` (and legacy alias) files.
- `decision` (default `1500`): applies to autoloaded `decisions/<id>.md` (and legacy alias) files.
- Each value must be a positive integer between `1` and `100000`. Truncated sections always keep the `[Truncated. Full file: <path>]` link to the full file. Integration-level hook limits (such as Codex's `additionalContextLimit`) are unchanged.

### Stale-save reminder

By default, `pctx hook` checks the calendar date in standard session filenames (`YYYY-MM-DD-HHmm-<project>-*.md`) across the visible repositories of the current project scope. When the most recent valid, non-future save for the project is at least `staleSaveDays` calendar days old (`ageDays >= staleSaveDays`, default `7`), the hook prints a `REMINDER:` line with the latest save date and age.

- Set `"staleSaveDays": 0` in `~/.pctx/config.json` to disable the reminder (valid integers: `0` to `3650`).
- Invalid filenames, invalid calendar dates, and future-dated files are ignored so they cannot hide an older save.
- If no saved session exists yet for the project, no reminder is shown.
- `pctx` never infers that the active session is unsaved and never saves automatically.

## Isolated teams and private destinations

You can optionally isolate any team by binding it to exact remotes or explicit namespaces on any Git server, with an optional dedicated private repo (`privateDir`) completely separate from your personal context repo:

```json
{
  "contextDir": "/home/alex/.pctx/context",
  "device": "laptop",
  "skillName": "save-context",
  "projectIdentity": "remote",
  "teams": [
    {
      "name": "acme",
      "url": "https://git.acme.example/platform/pctx-team.git",
      "dir": "/home/alex/.pctx/teams/acme",
      "isolated": true,
      "namespaces": [
        "git.acme.example/platform",
        "git.acme.example/core/services"
      ],
      "remotes": [
        "https://git.partner.example/shared/gateway.git"
      ],
      "privateDir": "/home/alex/.pctx/teams/acme-private",
      "privateUrl": "https://git.acme.example/alex/pctx-private.git"
    }
  ]
}
```

You can also pass these flags when adding a team:

```sh
pctx team add acme https://git.acme.example/platform/pctx-team.git \
  --isolated \
  --namespace git.acme.example/platform \
  --remote https://git.partner.example/shared/gateway.git \
  --private-url https://git.acme.example/alex/pctx-private.git
```

How isolated teams behave across commands:

- **Automatic resolution without `projects/*.md`**: any project matching a team's `remotes` or `namespaces` resolves to that team by its remote identity even before `projects/<id>.md` exists.
- **Strict hook isolation**: when starting a session in a personal repo, `pctx hook` never lists, refreshes, or retries pushes for isolated teams. When starting in an isolated team's repo, `pctx hook` loads and refreshes only that team and its `privateDir`, omitting your personal context and other teams.
- **Private writes (`--private`)**: `pctx session-path --private` inside an isolated project writes only to that team's `privateDir`. If `privateDir` is missing, unavailable, or overlaps the personal repo, the team repo, or another team's repo (including symlinks and equivalent paths), `pctx` fails with no path. The save skill also keeps `## Working style` isolated: it never compares or transfers observations from an isolated team to your personal `AGENTS.md`, and skips writing private notes if no private destination is configured.
- **Scoped `team share`, `scan`, and `sync`**: running `pctx scan` or `pctx sync` inside an isolated project operates only on that team and its `privateDir`. Passing `--project` from another `cwd` or with an unexpected value never routes an isolated project into the personal repo.
- **Explicit maintenance from an unrelated `cwd`**: to maintain an isolated team from outside its repositories (for example from `~`), pass `--team <name>` (for example `pctx sync --team acme`, `pctx scan --team acme`, or `pctx session-path --team acme --project git.acme.example/platform/api [--private]`).
- **Fail-safe errors**: if two teams match the same remote (ambiguous scope) or a configured scope/destination is invalid, commands fail safely without falling back to the personal repo.

## Compatibility

- **Legacy configs (`0.5.0` and earlier)**: configs without `projectIdentity` or team `isolated`/`remotes`/`namespaces` keep the exact legacy basename behavior.
- **Mixed mode**: you can keep legacy basename resolution for personal projects while adding `"isolated": true` and `remotes`/`namespaces` for specific teams; projects inside those configured scopes always resolve by remote identity.
- **Adopting `"projectIdentity": "remote"`**: existing personal `projects/*.md` notes are not matched by basename in remote mode; declare them in `"aliases"` or rename them to keep loading them.
- **Upgrading hooks and skills**: after updating `pctx`, run `pctx install` so the updated `save-context` skill is written to Claude Code, Codex, and Antigravity.

## Commands

| Command | What it does |
| --- | --- |
| `pctx setup <git-url> [--dir] [--device] [--author] [--skill-name] [--project-identity]` | Clone (and seed if empty) the context repo, save config, install hook and skill |
| `pctx team add <name> <git-url> [--dir] [--author] [--isolated] [--remote] [--namespace] [--private-dir] [--private-url]` | Clone (and seed if empty) a team repo and add it to the config |
| `pctx team share <name> [--project] [--cwd]` | Share a project with a team by creating its notes in the team repo |
| `pctx team remove <name>` / `pctx team list` | Stop loading a team (its clone is kept) / list teams |
| `pctx install` | Install the hook and skill into Claude Code, Codex and Antigravity, and the Codex rule for `pctx sync` |
| `pctx uninstall` | Remove the hook, skill and Codex rule that pctx installed |
| `pctx doctor` | Check the configuration, scope rules, private destinations, and installation |
| `pctx hook [--format antigravity]` | SessionStart hook: reads `{cwd}` (or Antigravity's `workspacePaths`) JSON on stdin, pulls the active scope, prints context (as `injectSteps` JSON with `--format antigravity`). Always exits 0 |
| `pctx session-path [--project] [--cwd] [--team] [--private]` | Print a new session file path and create `sessions/` (in the team repo for a shared/isolated project; `--private` uses your personal repo or the isolated team's `privateDir`) |
| `pctx sync [-m] [--cwd] [--team]` | Scan, commit, pull and push the active scope (personal + non-isolated teams, or the isolated team + its `privateDir`). Prints `synced` or `up-to-date` |
| `pctx scan [--cwd] [--team]` | Scan pending changes in the active scope for secrets and configured rules: `clean` or findings |

`sync` exit codes: 0 success; 2 a possible secret or configured personal-data match was found (nothing is committed or pushed in that repo, findings are listed as `file:line (rule)` without the value); 1 pull or push failed (`local-only: ...` on stderr, the commit is kept locally). With teams, the worst result of all repos sets the exit code.

Settings files are edited conservatively: other keys and hooks are preserved, invalid JSON is left unchanged and the command fails, the first change creates `<file>.pctx-backup`, and an existing `SKILL.md` that lacks `managed-by: portable-context` is never overwritten.

## Secret and configurable personal-data scanning

`pctx scan` and `pctx sync` always check added lines for global credential patterns (including private keys, cloud/API tokens, `GOCSPX-` Google OAuth client secrets, JWTs, connection strings, and literal secret assignments) on every repository.

In addition, you can opt in to built-in personal-data rules independently per repository destination in `~/.pctx/config.json`:

- **Personal context repo (`contextDir`)**: top-level `"scanRules"`
- **Team shared repo (`teams[].dir`)**: `"scanRules"` on that team entry
- **Isolated team private repo (`teams[].privateDir`)**: `"privateScanRules"` on that team entry

When a repository omits these fields, behavior is unchanged (only global credential rules run).

```json
{
  "contextDir": "/home/alex/.pctx/context",
  "device": "laptop",
  "skillName": "save-context",
  "scanRules": ["es-dni", "es-iban"],
  "teams": [
    {
      "name": "acme",
      "url": "https://git.acme.example/platform/pctx-team.git",
      "dir": "/home/alex/.pctx/teams/acme",
      "isolated": true,
      "namespaces": ["git.acme.example/platform"],
      "scanRules": ["es-pii"],
      "privateDir": "/home/alex/.pctx/teams/acme-private",
      "privateUrl": "https://git.acme.example/alex/pctx-private.git",
      "privateScanRules": ["es-mobile"]
    }
  ]
}
```

Available built-in IDs (collections and individual rules):

- `"es-pii"` (collection): enables all four rules below
- `"es-dni"`: Spanish DNI (8 digits + validated mod-23 control letter, e.g. `00000001R`)
- `"es-nie"`: Spanish NIE (`X`/`Y`/`Z` + 7 digits + validated mod-23 control letter, e.g. `X0000000T`)
- `"es-iban"`: Spanish IBAN (`ES` + 22 digits, compact or grouped, mod-97 validated, e.g. `ES8200000000000000000000` or `ES55 0000 0000 0000 0000 0001`)
- `"es-mobile"`: Spanish mobile numbers starting with `6` or `7`, `+34` prefix, and common separators (e.g. `+34 600 000 000`)

Validation and safety guarantees:

- Rule names and types are validated up front (`setup`, `team add`, `scan`, `sync`, `doctor`): unknown rule IDs, non-array values, or `privateScanRules` without a `privateDir` fail before any commit or push runs.
- Findings block only the affected repository (without committing or pushing it), exit with code `2`, and print `<file>:<line> (<rule>)` without printing the detected value.
- Arbitrary user-defined regexes are not supported.

## What is synced, and what is not

Synced: the markdown in your context repo, and in each team repo you added. Nothing else leaves your machine. There is no pctx server; only you (and, for a team repo, the people with access to it) and your git host see the data. Use private repos.

Never synced: your agents' own settings, credentials, or transcripts. Only what is written into the context repo is pushed.

Scanning runs only on the added lines that `pctx scan` / `pctx sync` stages for commit in each active repository. It does not scan or rewrite existing git history, remote history, or `pctx hook` startup pulls. It is a best-effort safety net, not a guarantee: free-form text such as people's names, postal addresses, unstructured notes, or identifiers outside the enabled built-in formats are not detected. Do not put secrets or sensitive personal data in your context.

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
