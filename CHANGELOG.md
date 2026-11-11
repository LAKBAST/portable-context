# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-11

### Added

- Antigravity integration. `pctx install` and `pctx setup` create a `portable-context` plugin in `ANTIGRAVITY_CONFIG_DIR` or `~/.gemini/config` with a SessionStart hook and the save skill. `pctx uninstall` removes it and `pctx doctor` reports it.
- `pctx hook --format antigravity` prints the context as Antigravity `injectSteps` JSON. It takes the project from the first entry of `workspacePaths`.

### Changed

- The CLI help, README and package description now cover Antigravity alongside Claude Code and Codex.

## [0.1.0] - 2026-11-01

### Added

- First release: one private git repo of markdown context loaded into Claude Code and Codex through a SessionStart hook, with a save skill, `setup`, `install`, `uninstall`, `doctor`, `session-path`, `sync` and `scan` commands, and secret scanning before each commit.

[0.2.0]: https://github.com/LAKBAST/portable-context/releases/tag/v0.2.0
[0.1.0]: https://github.com/LAKBAST/portable-context/tree/eab6387
