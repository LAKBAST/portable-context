# Team context

Context shared by a team through `pctx`. Everyone with access to this repo reads it.

- `AGENTS.md`: team conventions, loaded in sessions of the team's projects.
- `projects/<repo-name>.md`: current state of a shared project. A project is shared when its file exists here.
- `sessions/`: session summaries of shared projects, named `YYYY-MM-DD-HHmm-<project>-<author>-<device>.md`.

Add it on each device with `pctx team add <name> <git-url>`, and share a project with `pctx team share <name>`. Do not store credentials here.
