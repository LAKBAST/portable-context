# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[0.4.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.4.0
[0.3.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.3.0
[0.2.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.2.0
[0.1.0]: https://github.com/LAKBAST/portable-context/tree/eab6387
