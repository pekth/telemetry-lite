#!/usr/bin/env node
// telemetry-lite - test suite
// Zero-dependency (node: built-ins only) assertions on the data-loss-critical
// invariants: single-flight flush, send-exactly-what-was-sent removal, drop-oldest
// queue cap, persist-failure surfacing, and the error reporter's rate-limit + dedup.
//
//   node telemetry.test.js     # exit 0 = all pass

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "telemetry.js"), "utf8");

// ── tiny browser-env harness ─────────────────────────────────────────
// Load the IIFE into a fresh vm context with just enough of the browser surface
// stubbed. setInterval/setTimeout are no-ops so no real timer is scheduled (flush is
// driven by hand); fetch is injected per test. Each call returns a fresh client.
function loadClient(fetchImpl) {
  const listeners = {};
  const win = {
    addEventListener: (t, fn) => (listeners[t] || (listeners[t] = [])).push(fn),
    fetch: fetchImpl,
  };
  const sandbox = {
    window: win,
    location: { href: "https://app.test/page?q=secret", pathname: "/page" },
    fetch: fetchImpl,
    crypto,
    TextEncoder,
    AbortController,
    URL,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { log: () => {} },
    Date,
    Math,
    JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return win.Telemetry;
}

function memStorage(opts = {}) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (opts.failWrites) return false;
      m.set(k, v);
      return true;
    },
  };
}

function okFetch() {
  const calls = [];
  const f = (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, status: 200 });
  };
  f.calls = calls;
  return f;
}

function deferredFetch() {
  const calls = [];
  const f = (_url, opts) => {
    let resolve, reject;
    const p = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({
      events: JSON.parse(opts.body).events,
      ok: () => resolve({ ok: true, status: 200 }),
      fail: (e) => reject(e || new Error("net")),
    });
    return p;
  };
  f.calls = calls;
  return f;
}

function pendingFetch() {
  const calls = [];
  const f = (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return new Promise(() => {});
  };
  f.calls = calls;
  return f;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const cfg = (over) => Object.assign({ appId: "x", endpoint: "https://i.test/e" }, over);

const CHECKS = [];
async function check(name, fn) {
  try {
    await fn();
    CHECKS.push([name, true, ""]);
  } catch (e) {
    CHECKS.push([name, false, (e && e.message) || String(e)]);
  }
}

(async () => {
  await check("flush sends the batch and clears the queue on 200", async () => {
    const f = okFetch();
    const p = loadClient(f);
    p.init(cfg({ storage: memStorage() }));
    p.track("e1");
    p.track("e2");
    await p.flush();
    assert.equal(f.calls.length, 1, "one POST");
    assert.equal(f.calls[0].events.length, 2);
    assert.equal(p.queue.length, 0, "queue cleared on success");
  });

  await check("flush keeps events in the queue when ingest fails", async () => {
    const f = deferredFetch();
    const p = loadClient(f);
    p.init(cfg({ storage: memStorage() }));
    p.track("e1");
    const flushed = p.flush();
    f.calls[0].fail(new Error("ingest 500"));
    await flushed;
    await tick();
    assert.equal(p.queue.length, 1, "kept for retry");
    assert.equal(p._inflight, false, "inflight flag reset after failure");
  });

  await check("concurrent flushes do not double-send (single-flight)", async () => {
    const f = deferredFetch();
    const p = loadClient(f);
    p.init(cfg({ storage: memStorage() }));
    for (let i = 0; i < 5; i++) p.track("e" + i);
    const first = p.flush();
    p.flush();
    p.flush();
    assert.equal(f.calls.length, 1, "exactly one request in flight");
    f.calls[0].ok();
    await first;
    await tick();
    assert.equal(p.queue.length, 0);
  });

  await check("removal is by event_id, surviving a mid-flight queue trim", async () => {
    const f = deferredFetch();
    const p = loadClient(f);
    p.init(cfg({ storage: memStorage() }));
    p.track("a");
    p.track("b");
    const flushed = p.flush(); // batch = [a, b]
    assert.deepEqual(f.calls[0].events.map((e) => e.event), ["a", "b"]);
    p.track("c"); // queued while the request is in the air -> [a, b, c]
    p.queue.shift(); // simulate the MAX_QUEUE cap dropping the oldest mid-flight -> [b, c]
    f.calls[0].ok(); // a, b acked
    await flushed;
    await tick();
    // position-slice(batch.length) would have dropped [b, c] and lost the unsent c;
    // id-based removal drops only the sent a/b and preserves c.
    assert.deepEqual(p.queue.map((e) => e.event), ["c"], "only the unsent event remains");
  });

  await check("queue is capped at MAX_QUEUE (500), dropping the oldest", async () => {
    const p = loadClient(pendingFetch());
    p.init(cfg({ storage: memStorage(), maxBatch: 1e9 })); // never auto-flush
    for (let i = 0; i < 530; i++) p.track("e" + i);
    assert.equal(p.queue.length, 500, "capped at 500");
    assert.equal(p.queue[0].event, "e30", "oldest 30 dropped");
    assert.equal(p.queue[499].event, "e529", "newest kept");
  });

  await check("persist failure surfaces an app_error once, then stays silent", async () => {
    const p = loadClient(pendingFetch());
    p.init(cfg({ storage: memStorage({ failWrites: true }) }));
    p.track("e1");
    let errs = p.queue.filter((e) => e.event === "app_error");
    assert.equal(errs.length, 1, "one storage app_error emitted");
    assert.equal(errs[0].props.kind, "storage");
    assert.equal(p._persistWarned, true, "warned flag set");
    p.track("e2");
    errs = p.queue.filter((e) => e.event === "app_error");
    assert.equal(errs.length, 1, "not re-emitted on subsequent failures");
  });

  await check("error reporter caps at 10 per minute", async () => {
    const p = loadClient(pendingFetch());
    p.init(cfg({ storage: memStorage() }));
    for (let i = 0; i < 15; i++) p.reportError("boom " + i);
    const errs = p.queue.filter((e) => e.event === "app_error");
    assert.equal(errs.length, 10, "rate-limited to 10/min/device");
  });

  await check("identical error messages dedupe within the 60s window", async () => {
    const p = loadClient(pendingFetch());
    p.init(cfg({ storage: memStorage() }));
    p.reportError("same boom");
    p.reportError("same boom");
    p.reportError("same boom");
    const errs = p.queue.filter((e) => e.event === "app_error");
    assert.equal(errs.length, 1, "deduped to one");
  });

  await check("a new session starts after the 30-min idle gap", async () => {
    const p = loadClient(okFetch());
    p.init(cfg({ storage: memStorage() }));
    const s1 = p.sessionId;
    p.track("a");
    assert.equal(p.sessionId, s1, "same session while active");
    p.lastActivity = Date.now() - 31 * 60 * 1000;
    p.track("b");
    assert.notEqual(p.sessionId, s1, "session rolled after the gap");
  });

  await check("trackOnce fires once per device key", async () => {
    const p = loadClient(pendingFetch());
    p.init(cfg({ storage: memStorage() }));
    p.trackOnce("activated", "first_activation");
    p.trackOnce("activated", "first_activation");
    const hits = p.queue.filter((e) => e.event === "first_activation");
    assert.equal(hits.length, 1, "second call is a no-op");
  });

  let pass = 0;
  for (const [name, ok, msg] of CHECKS) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + msg}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${CHECKS.length} passed`);
  process.exit(pass === CHECKS.length ? 0 : 1);
})();
