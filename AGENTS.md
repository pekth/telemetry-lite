# telemetry-lite repository instructions

## Repo front door

- Treat [README.md](README.md) as the product entry point.
- Read [docs/KB.md](docs/KB.md) for public repository facts and known gaps.
- Read [docs/adr/README.md](docs/adr/README.md) when a task changes or relies on a repository decision.

## Knowledge maintenance

- Keep project facts in `docs/KB.md` and decisions in `docs/adr/`.
- Update those files in the same agent change when the change alters a documented fact or decision.
- Cite repository files and verified revisions. Mark runtime, endpoint, deployment, and external-service state unknown unless the task verifies it.
- Keep public documentation safe. Do not add credentials, personal data, private agent or orchestration instructions, private repository references, or local absolute paths.
- Do not add scheduled knowledge-sync workflows. Repository knowledge is maintained beside the project through ordinary agent changes.

## Validation

- Run the smallest meaningful check after edits. For documentation-only changes, run `git diff --check` and inspect the complete diff.
- For source changes, use the repository's `npm test` command.
