# telemetry-lite

Project facts for coding agents and contributors.

Tiny, dependency-free, offline-first web telemetry and error-tracking SDK.

## Layout

- `telemetry.js`: SDK. `telemetry.test.js`: tests. `server/ingest.mjs`: reference ingest server (`npm run serve`). `demo/`: example page.

## Verify

Matches CI (`.github/workflows/`):

- `npm install --no-audit --no-fund`
- `npm test`

## Rules

- Public repository: no credentials, personal data, private repository references, or absolute local paths.

## Docs

- Facts and known gaps: [`docs/KB.md`](docs/KB.md). Update it in the same change when a documented fact changes.
- Decisions: [`docs/adr/`](docs/adr/README.md). Read the linked ADR before changing a recorded decision.

## Issues and PRs

Issue forms in `.github/ISSUE_TEMPLATE/` apply the `bug`, `feature`, and `chore` labels.
