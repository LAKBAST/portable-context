# Portable context

Private context shared by Claude Code, Codex and Antigravity across devices. Managed with `pctx`.

- `AGENTS.md`: profile loaded in every session. Keep it short.
- `projects/<project-id>.md`: current state of a project, loaded when working in that repo (basename in legacy mode, or `<host-path>--<hash>` with `"projectIdentity": "remote"`).
- `sessions/`: one summary per saved session, named `YYYY-MM-DD-HHmm-<project>-<device>.md`, with a `## Working style` section about how you worked in it.
- `decisions/`: long-term decisions worth keeping.

Run `pctx sync` to scan for secrets, commit, pull and push. Do not store credentials here.
