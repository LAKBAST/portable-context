# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-11-23

### Added

- Remote-based project identity (`"projectIdentity": "remote"` in `~/.pctx/config.json` or `--project-identity remote` on `pctx setup`): identifies projects by normalized `(host, full remote path)` mapped to `<slug>--<hash10>`, preserving non-default ports and path capitalization, stripping credentials before hashing and from output, and falling back to `local--<folder-slug>` without an `origin` remote (including Windows drive paths).
- Explicit migration aliases (`"aliases"` in `~/.pctx/config.json`): maps legacy project names to canonical remote paths only within the repository that declares them, reading existing `projects/<alias>.md`, `decisions/<alias>.md`, and `sessions/*-<alias>-*.md` history without basename guessing while writing new files under the remote ID.
- Configurable team isolation and dedicated private destinations (`--isolated`, `--remote`, `--namespace`, `--private-dir`, and `--private-url` on `pctx team add`, or `"isolated"`, `"remotes"`, `"namespaces"`, `"privateDir"`, and `"privateUrl"` in `~/.pctx/config.json`): matches projects by remote or namespace before `projects/<id>.md` exists, isolates `hook`, `scan`, `sync`, `session-path`, `team share`, and `save-context` (`## Working style`) per scope, supports explicit `--team <name>` maintenance from unrelated directories, and fails safely on ambiguous scopes or missing/overlapping private destinations without falling back to the personal repo.
- Global detection of `GOCSPX-` Google OAuth client secrets in `pctx scan` and `pctx sync`.
- Opt-in per-repository personal-data scan rules (`"scanRules"` for personal `contextDir` and team `teams[].dir`; `"privateScanRules"` for isolated team `teams[].privateDir`) with built-in Spanish rules (`es-pii`, `es-dni`, `es-nie`, `es-iban`, `es-mobile`), mod-23/mod-97 checksum validation, up-front config validation across `setup`, `team add`, `scan`, `sync`, and `doctor`, and block explanations in the `save-context` skill.
- Bounded `## Decisions` index and project decision autoload (`decisions/<project-id>.md` and declared `decisions/<alias>.md`) in `pctx hook`, ignoring symlinks or junctions pointing outside the repository.
- Configurable per-file character truncation limits (`"limits"` in `~/.pctx/config.json`: `profile` default `3000`, `project` default `4000`, `decision` default `1500`; valid range `1`–`100000`) while keeping `[Truncated. Full file: <path>]` links.
- Configurable stale-save reminder (`"staleSaveDays"` in `~/.pctx/config.json`, default `7`, valid range `0`–`3650`, `0` disables) in `pctx hook` when the latest valid, non-future session save for the project reaches that age in calendar days.
- Per-clone hook refresh cache (`"hookRefreshSeconds"` in `~/.pctx/config.json`, default `120`, valid range `0`–`86400`, `0` disables caching) stored under `$PCTX_HOME/hook-refresh/` with credential-free keys so rapid `startup`/`resume`/`clear` hooks skip redundant pulls and pushes until the interval elapses or after a failed refresh.

### Changed

- Existing configs without `projectIdentity` or team `isolated`/`remotes`/`namespaces` keep legacy basename resolution and unisolated behavior; remote identity and team isolation activate only when explicitly configured (and support mixed mode).
- Repositories without `scanRules` or `privateScanRules` continue running only the global credential rules.
- `pctx hook` skips all `pull`, `fetch`, and `push` operations across every repo when invoked with `source: "compact"`, printing only local context for the active scope; manual `pctx sync` ignores the refresh cache and always runs explicitly.

### Fixed

- `npm test` now invokes `node --test` without shell glob expansion so the full test suite runs on Windows with Node 20 as well as newer Node versions.

## [0.5.0] - 2026-11-18

### Added

- The save skill writes a `## Working style` section in every session about the person using pctx (how they asked, what they corrected or rejected, what annoyed them, how they decided, short literal quotes), so agents can learn how each user works. The title stays in English in every language so tools can find it; for a project shared with a team it goes to the private session.
- When a working-style pattern repeats in two or more sessions and the profile does not say it yet, the save skill proposes the exact line to add to the profile and changes it only if the user agrees.

## [0.4.0] - 2026-11-11

### Added

- `pctx install` writes `~/.codex/rules/pctx.rules`, a Codex rule that lets the save skill run `pctx sync` without approval, so Codex's automatic review no longer stops a save because the notes mention internal infrastructure. `pctx uninstall` removes it, and `pctx doctor` reports it.

## [0.3.0] - 2026-11-11

### Added

- Teams: shared context repos for working with other people while each person keeps a private context repo. `pctx team add <name> <git-url>` clones or seeds a team repo from a new team template, `pctx team share <name>` shares the current project, and `pctx team remove` and `pctx team list` manage them.
- For a shared project, the hook loads the team's `AGENTS.md`, the team notes and the latest team sessions, and `pctx session-path` points into the team repo with the author in the file name.
- `--author` on `setup` and `team add` sets the name used in team sessions (defaults to the device name).
- `pctx session-path --private` always returns a path in the personal context repo, even for a shared project.
- The save skill can share a project with a team: it runs `pctx team share` and moves into the team notes only what the team needs from the private notes.
- When saving a shared project, the save skill writes what is not for the team (or what it is unsure about) to a private session and reports what went where.

### Changed

- `pctx sync` and `pctx scan` cover every team repo too; with teams, each output line starts with its repo and the worst result sets the exit code.
- The hook shares one time budget across all repos so it stays under the 30-second SessionStart timeout, and warns about any team it could not refresh.
- `pctx setup` run again keeps the teams and author already in the config.
- The save skill tells the agent that team repos are read by others and must hold only the shared project. Its description now also covers sharing a project with a team.

## [0.2.0] - 2026-11-11

### Added

- Antigravity integration. `pctx install` and `pctx setup` create a `portable-context` plugin in `ANTIGRAVITY_CONFIG_DIR` or `~/.gemini/config` with a SessionStart hook and the save skill. `pctx uninstall` removes it and `pctx doctor` reports it.
- `pctx hook --format antigravity` prints the context as Antigravity `injectSteps` JSON. It takes the project from the first entry of `workspacePaths`.

### Changed

- The CLI help, README and package description now cover Antigravity alongside Claude Code and Codex.

## [0.1.0] - 2026-11-01

### Added

- First release: one private git repo of markdown context loaded into Claude Code and Codex through a SessionStart hook, with a save skill, `setup`, `install`, `uninstall`, `doctor`, `session-path`, `sync` and `scan` commands, and secret scanning before each commit.

[0.6.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.6.0
[0.5.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.5.0
[0.4.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.4.0
[0.3.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.3.0
[0.2.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.2.0
[0.1.0]: https://github.com/LAKBAST/portable-context/tree/eab6387
