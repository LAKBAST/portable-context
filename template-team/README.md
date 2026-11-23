# Team context

Context shared by a team through `pctx`. Everyone with access to this repo reads it.

- `AGENTS.md`: team conventions, loaded in sessions of the team's projects.
- `projects/<project-id>.md`: current state of a shared project. A project belongs to a team when its file exists here or when its remote matches the team's configured `remotes`/`namespaces`.
- `sessions/`: session summaries of shared projects, named `YYYY-MM-DD-HHmm-<project>-<author>-<device>.md`.

Add it on each device with `pctx team add <name> <git-url>`, and share a project with `pctx team share <name>`. Do not store credentials here.
