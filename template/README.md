# Portable context

Private context shared by Claude Code and Codex across devices. Managed with `pctx`.

- `AGENTS.md`: profile loaded in every session. Keep it short.
- `projects/<repo-name>.md`: current state of a project, loaded when working in the repo of that name.
- `sessions/`: one summary per saved session, named `YYYY-MM-DD-HHmm-<project>-<device>.md`.
- `decisions/`: long-term decisions worth keeping.

Run `pctx sync` to scan for secrets, commit, pull and push. Do not store credentials here.
