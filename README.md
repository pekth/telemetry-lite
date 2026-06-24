# telemetry-lite

A tiny, dependency-free, offline-first web telemetry + error-tracking SDK you fully own.

One file, no build step, no third party.
Drop `telemetry.js` into any page, point it at an HTTP endpoint you control, and you get product analytics events and crash reporting that never leave your own infrastructure.

```js
Telemetry.init({ appId: "my-app", endpoint: "https://example.com/events" });
Telemetry.track("signup_started", { plan: "pro" });
Telemetry.screen("home");
```

## Why

- **Offline-first.** Events are queued in `localStorage` and flushed in batches. They survive reloads and offline periods, and a failed flush keeps them for the next retry - nothing is dropped on a network blip.
- **Zero dependencies, ~9 KB, no build.** It is one ES5 script that attaches `window.Telemetry`. No bundler, no npm install required to ship it.
- **Errors included.** Uncaught errors and unhandled promise rejections become `app_error` events automatically, each carrying a short breadcrumb trail of the screens/events that led up to it.
- **Privacy by construction.** Anonymous ids are random; user ids are SHA-256 hashed on the device; URLs are reduced to the pathname (never the query string); breadcrumbs are event/screen names only, never values.
- **Yours.** The only network call is the `POST` to your endpoint. There is no vendor, no account, no shared backend.

## Quick start

1. Add the script:

   ```html
   <script src="telemetry.js"></script>
   ```

2. Initialise once, as early as possible:

   ```js
   Telemetry.init({
     appId: "my-app",
     endpoint: "https://example.com/events",
     appVersion: "1.4.0", // optional, attached to every event
   });
   ```

3. Track whatever you care about:

   ```js
   Telemetry.track("checkout_completed", { items: 3, currency: "USD" });
   Telemetry.screen("pricing");
   Telemetry.trackOnce("activated", "first_value"); // fires at most once per device
   ```

That is the whole integration. Events flush every 15 seconds, when a batch fills up, and when the tab is hidden.

## Try it locally

No account, no signup - run the full loop on your machine:

```bash
# 1. start the reference ingest endpoint (zero-dependency Node)
node server/ingest.mjs        # listens on http://localhost:8787/events

# 2. open the demo in a browser (any static server works)
python3 -m http.server 8000   # then visit http://localhost:8000/demo/
```

Click the buttons, watch events print in the server terminal, and watch the pending queue in the page.
Stop the server, keep clicking, restart it - the queue drains and nothing is lost.

Run the test suite (zero dependencies, Node only):

```bash
npm test        # or: node telemetry.test.js
```

## API

### `Telemetry.init(options)`

| option | default | meaning |
| --- | --- | --- |
| `appId` | (required) | string identifying the app/site |
| `endpoint` | (required) | URL that receives `POST { events: [...] }` |
| `flushIntervalMs` | `15000` | how often the timer flushes |
| `maxBatch` | `25` | events per flush; also the auto-flush threshold |
| `storage` | `localStorage` | a `{ getItem, setItem }` adapter; bring your own |
| `platform` | `"web"` | free-form string stamped on every event |
| `appVersion` | `undefined` | optional version string stamped on every event |
| `errors` | `true` | capture uncaught errors + promise rejections |
| `fetchErrors` | `false` | also report failed fetches (`>= 500` or network error) |
| `debug` | `false` | `console.log` internal activity |

### Methods

- `track(event, props)` - record an event with an optional flat props object.
- `screen(name, props)` - shorthand for a `screen_view` event.
- `trackOnce(flagKey, event, props)` - fire an event at most once ever per device (activation milestones).
- `identifyUser(rawId)` - attach a hashed user id (`await`able). The raw id is SHA-256 hashed on the device; the raw value never leaves it.
- `reportError(message, stack, extra)` - manually report a caught error through the same pipe (and rate limit) the global hooks use. Useful where you swallow your own errors and they never reach `window.onerror`.
- `flush()` - force a flush now (returns a promise).

## Event payload

Each event your endpoint receives looks like this:

```json
{
  "event_id": "1f1c…",
  "app_id": "my-app",
  "anon_id": "9b2a…",
  "user_hash": "e3b0…",
  "session_id": "7d44…",
  "event": "checkout_completed",
  "props": { "items": 3, "currency": "USD" },
  "platform": "web",
  "app_version": "1.4.0",
  "schema_version": 1,
  "occurred_at": "2026-01-01T00:00:00.000Z"
}
```

Batches arrive as `{ "events": [ … ] }`.

## The ingest contract

Your endpoint only has to do one thing reliably:

> Accept `POST { events: [...] }`. Durably store the batch, **then** respond `2xx`.
> Respond non-`2xx` (or let the request fail) and the SDK keeps the events and retries.

That is the entire protocol. `server/ingest.mjs` is a ~50-line reference implementation (Node, no dependencies) that appends batches to an `events.ndjson` file - swap it for a serverless function, a queue, or a database insert. Because acknowledgement is what tells the client to drop events, **store before you ack**.

## How it survives failure

These are the invariants the SDK is built around. They are not aspirational - each one is asserted by `telemetry.test.js`, and the suite is mutation-tested (reverting any one fix turns its test red):

- **Single flush in flight.** The timer, the tab-hide handler, and the batch-full trigger can all fire at once; only one request goes out at a time, so two flushes can't each drop the same events.
- **Acknowledge exactly what was sent.** On success the client removes events by `event_id`, not by position - so events queued (or trimmed by the cap) while a request was in the air are never lost.
- **Bounded queue.** Beyond 500 queued events the oldest are dropped, protecting the storage quota.
- **Loud persistence failures.** If `localStorage` is full or blocked (private mode), the client surfaces one `app_error` instead of silently becoming memory-only.
- **Polite error capture.** At most 10 errors per minute per device, identical messages deduped within a minute, stacks capped.

## Notes

- **Other environments.** The default storage adapter uses `localStorage`. For React Native, a worker, or Node, pass your own `storage: { getItem, setItem }` (e.g. backed by `AsyncStorage`). `setItem` should return `false` on failure so persistence problems stay visible.
- **Opting out of error capture.** `init({ errors: false })` disables the global hooks; `reportError(...)` then becomes a no-op too.
- **Sampling / consent.** There is none built in by design - call `track` only when you should. Gate `init` behind your consent flow if you need to.

## License

MIT - see [LICENSE](LICENSE).
