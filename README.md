<h1 align="center">telemetry-lite</h1>

<p align="center">
  <strong>A tiny, dependency-free, offline-first web telemetry and error-tracking SDK you fully own.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/bundle%20size-~9%20KB-blue?style=flat-square" alt="Bundle Size: ~9 KB">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/architecture-offline--first-orange?style=flat-square" alt="Offline-First Architecture">
  <img src="https://img.shields.io/badge/privacy-self--hosted%20%7C%20device%20hashing-purple?style=flat-square" alt="Self-Hosted Privacy">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License: MIT">
</p>

---

### ⚡ TL;DR

**telemetry-lite** gives you privacy-friendly product analytics and automatic crash reporting without a third-party SaaS vendor. Drop `telemetry.js` into any web app, point it at an HTTP endpoint you control, and own your event stream.

* 🛡️ **Zero Third Parties**: Direct `POST` to your own endpoint. No vendor accounts, no tracking cookies, and no cross-site identifiers.
* 💾 **Offline-First & Durable**: Events queue in `localStorage` and survive page reloads and network loss. Batches retry automatically with single-flight locking so no events duplicate or drop.
* 🚨 **Automatic Crash Reporting**: Traps uncaught errors and unhandled promise rejections with the trail of recent screen views and actions that caused them.
* 🔒 **Privacy-by-Design**: User IDs are SHA-256 hashed strictly on-device before transmission, URLs strip query parameters to avoid leaking secrets, and breadcrumb trails carry names only—never sensitive values.
* ⚡ **Zero Dependencies, No Build Step**: One standalone ~9 KB script. Just include it via `<script>` or bundle with your favorite framework.

```html
<script src="telemetry.js"></script>
<script>
  Telemetry.init({ appId: "my-app", endpoint: "https://example.com/events" });
  Telemetry.track("signup_completed", { plan: "pro" });
  Telemetry.screen("dashboard");
</script>
```

---

## 🚀 Quick Start

### 1. Include the SDK
Include the script directly or load it asynchronously:
```html
<script src="telemetry.js"></script>
```

### 2. Initialise Early
```js
Telemetry.init({
  appId: "my-app",
  endpoint: "https://example.com/events",
  appVersion: "1.4.0", // optional: stamped on every event
});
```

### 3. Track Actions & Screens
```js
// Track custom product events
Telemetry.track("checkout_completed", { items: 3, currency: "USD" });

// Track page / screen views
Telemetry.screen("pricing");

// Track one-time activation milestones (fires at most once ever per device)
Telemetry.trackOnce("activated", "first_project_created");

// Attach an on-device hashed user identifier
await Telemetry.identifyUser("user_12345");
```

> **Flush cadence**: Events flush automatically every 15 seconds, whenever a batch reaches 25 events, and cleanly on page hide / unload (`visibilitychange`).

---

## 💻 Try It Locally in 60 Seconds

Run the complete telemetry loop locally on your machine with zero configuration:

```bash
# 1. Start the reference ingest endpoint (zero-dependency Node server)
node server/ingest.mjs        # listens on http://localhost:8787/events

# 2. Serve the demo page
python3 -m http.server 8000   # open http://localhost:8000/demo/
```

1. Click the test buttons in the demo page to produce events and simulated errors.
2. Watch batches print live in your ingest server terminal.
3. Stop the server, keep clicking, and restart the server—the local queue automatically drains without dropping a single event.

### Run Unit Tests
```bash
npm test        # or: node telemetry.test.js
```

---

## 📖 API Reference

### `Telemetry.init(options)`

| Option | Default | Description |
|---|:---:|---|
| `appId` | *(required)* | Identifier for the application or website |
| `endpoint` | *(required)* | URL endpoint receiving `POST { events: [...] }` |
| `flushIntervalMs` | `15000` | Periodic timer interval between batch flushes (ms) |
| `maxBatch` | `25` | Maximum events per flush batch & auto-flush threshold |
| `storage` | `localStorage` | Storage adapter `{ getItem, setItem }` (pluggable) |
| `platform` | `"web"` | Platform label stamped on every event payload |
| `appVersion` | `undefined` | Version string stamped on every event payload |
| `errors` | `true` | Automatically capture uncaught exceptions and unhandled rejections |
| `fetchErrors` | `false` | Report failed fetch requests (`status >= 500` or network drops) |
| `debug` | `false` | Enable verbose internal `console.log` logging |

### Methods

* **`Telemetry.track(event, props)`** — Records an event with an optional flat dictionary of properties.
* **`Telemetry.screen(name, props)`** — Shorthand for recording a `screen_view` event.
* **`Telemetry.trackOnce(flagKey, event, props)`** — Fires an event at most once per device lifetime.
* **`Telemetry.identifyUser(rawId)`** — Hashes the ID with SHA-256 on device and associates subsequent events with `user_hash`.
* **`Telemetry.reportError(message, stack, extra)`** — Manually reports a caught exception through the rate-limited crash pipe with breadcrumbs.
* **`Telemetry.flush()`** — Returns a Promise forcing an immediate queue flush.

---

## 📦 Event Schema

Batches arrive at your endpoint formatted as `{ "events": [ ... ] }`:

```json
{
  "event_id": "b78b6716-e57c-4731-b3b4-52d83b27bcfb",
  "app_id": "my-app",
  "anon_id": "9b2a758e-d9a2-4a0b-9689-91894d075253",
  "user_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "session_id": "7d448108-c70e-436f-b2b0-9602bc6825c9",
  "event": "checkout_completed",
  "props": { "items": 3, "currency": "USD" },
  "platform": "web",
  "app_version": "1.4.0",
  "schema_version": 1,
  "occurred_at": "2026-01-01T00:00:00.000Z"
}
```

---

## 🛡️ Reliability Invariants

The client SDK enforces strict invariants verified by the test suite:

1. **Single Flight Flush**: Concurrent triggers (timer, tab hide, batch threshold) share a single in-flight network request to prevent duplicated payloads.
2. **ID-Based Queue Eviction**: Events are evicted by `event_id` rather than queue index, ensuring new items enqueued during transit are never lost.
3. **Queue Clamping**: Local storage is capped at 500 items, discarding the oldest entries under extended offline periods.
4. **Rate-Limited Crash Reporting**: Crash captures are throttled to a maximum of 10 errors per minute per device with deduplication.

---

## 📄 License

MIT © [pekth](https://github.com/pekth)
