# Project knowledge

Last verified: 2026-08-25

## Repository state

- Default branch: `main`.
- Verified source revision: `f3d4833e951c92524a6920743eb81aeea5595223`.
- The clean checkout was verified before this documentation change. This index is public-safe repository documentation. It does not prove runtime behavior, endpoint deployment, or external-service state.

## Product and source facts

- telemetry-lite is a dependency-free, offline-first JavaScript telemetry and error-tracking SDK. `README.md` describes event tracking, screen events, error capture, local queueing, retries, and an endpoint supplied by the integrating application.
- The SDK is the single `telemetry.js` file and exposes `window.Telemetry`. It uses `localStorage` by default, supports a custom storage adapter, and reduces URLs and breadcrumbs before events are sent, as described in `README.md` and the source.
- The ingest contract accepts `POST { events: [...] }`, stores a batch before returning `2xx`, and keeps events queued after a failed request. `server/ingest.mjs` is a local reference receiver, not a hosted service.
- `telemetry.test.js` is a Node-only test suite for single-flight flushing, exact acknowledgement, queue bounds, persistence-failure reporting, error limits, deduplication, sessions, and one-time events. `package.json` defines `npm test` and the local ingest command.
- The repository is MIT licensed, as recorded in `package.json` and `LICENSE`.

## Privacy and verification gaps

- The SDK sends events only to the endpoint chosen by the integrator. Event properties remain application-controlled. Review the payload and consent model of each integration before use.
- Repository files do not prove endpoint durability, production CORS/authentication, browser compatibility, deployment, or the privacy compliance of an integrating application.

## Public disclosure boundary

- This KB contains only public repository facts. Do not add credentials, personal data, private agent or orchestration instructions, private repository references, or local absolute paths.

## Repository references

- [`README.md`](../README.md): SDK contract, usage, privacy behavior, and local test flow.
- [`telemetry.js`](../telemetry.js): SDK implementation and data-reduction behavior.
- [`telemetry.test.js`](../telemetry.test.js): dependency-free regression suite.
- [`server/ingest.mjs`](../server/ingest.mjs): local reference receiver.
- [`package.json`](../package.json): package metadata and scripts.
- [`AGENTS.md`](../AGENTS.md): public-safe repository operating and knowledge-maintenance rules.
- [`docs/adr/README.md`](adr/README.md): decision index.
