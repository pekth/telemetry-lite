/*
 * telemetry-lite - a tiny, dependency-free, offline-first web telemetry + error
 * tracking SDK you fully own. Drop this one file into any page (no build step) and
 * point it at an HTTP endpoint you control.
 *
 * What it does:
 *   - Queues events in localStorage and flushes them in batches (survives reloads
 *     and offline; retries on failure - events are never dropped on a flush error).
 *   - Captures uncaught errors + unhandled promise rejections (and, optionally,
 *     failed fetches) as `app_error` events, with a short breadcrumb trail.
 *   - Privacy-first: ids are random or SHA-256 hashed, URLs are reduced to the
 *     pathname (never the query string), breadcrumbs are event/screen NAMES only.
 *
 * Usage:
 *   Telemetry.init({ appId: 'my-app', endpoint: 'https://example.com/events' });
 *   Telemetry.track('button_click', { id: 'signup' });
 *   Telemetry.screen('home');
 *
 * Public domain of YOUR data: the only network call is the POST to your `endpoint`.
 */
(function () {
  var KEY_ANON = "tl_anon";
  var KEY_QUEUE = "tl_queue";
  var SESSION_GAP_MS = 30 * 60 * 1000; // a 30-min idle gap starts a new session
  var SCHEMA_VERSION = 1;
  var MAX_QUEUE = 500; // drop-oldest beyond this - protect the storage quota
  var MAX_CRUMBS = 20; // breadcrumb trail length attached to errors
  var CRUMBS_CAP = 1500; // max chars of joined breadcrumbs sent
  var FLUSH_TIMEOUT_MS = 10000; // abort a flush request after this long

  function uuid() {
    var c = typeof crypto !== "undefined" ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (ch) {
      var r = (Math.random() * 16) | 0;
      return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // Default storage adapter. setItem returns a boolean so persist() can SURFACE a
  // quota / private-mode failure instead of silently voiding the "never drops" contract.
  var localAdapter = {
    getItem: function (k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    setItem: function (k, v) {
      try {
        localStorage.setItem(k, v);
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  function TelemetryClient() {
    this.cfg = null;
    this.anonId = "";
    this.sessionId = "";
    this.userHash = undefined;
    this.lastActivity = 0;
    this.queue = [];
    this.timer = null;
    this.ready = false;
    this.crumbs = [];
    this._inflight = false;
    this._persistWarned = false;
  }

  /*
   * init(cfg) - start the client. Options:
   *   appId          (required) string identifying the app/site
   *   endpoint       (required) URL that receives POST { events: [...] }
   *   flushIntervalMs default 15000
   *   maxBatch        default 25 - events per flush; also the auto-flush threshold
   *   storage         default localStorage adapter; pass your own { getItem, setItem }
   *   platform        default 'web'
   *   appVersion      optional string, attached to every event
   *   errors          default true - hook window error/rejection capture
   *   fetchErrors     default false - also report failed fetches (>=500 / network)
   *   debug           default false - console.log internal activity
   */
  TelemetryClient.prototype.init = function (cfg) {
    this.cfg = Object.assign(
      { flushIntervalMs: 15000, maxBatch: 25, storage: localAdapter, platform: "web" },
      cfg,
    );
    var s = this.cfg.storage;
    this.anonId = s.getItem(KEY_ANON) || uuid();
    s.setItem(KEY_ANON, this.anonId);
    try {
      this.queue = JSON.parse(s.getItem(KEY_QUEUE) || "[]");
    } catch (e) {
      this.queue = [];
    }
    this.newSession();
    this.ready = true;
    var self = this;
    this.timer = setInterval(function () {
      self.flush();
    }, this.cfg.flushIntervalMs);
    this.flush();
    // flush on tab hide so we don't lose the tail of a session
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") self.flush();
      });
    }
    if (this.cfg.errors !== false) this._hookErrors();
    if (this.cfg.fetchErrors) this._hookFetch();
    this.log("init", this.anonId);
  };

  /* Breadcrumb: remember the last MAX_CRUMBS event/screen names (names only - never
   * props, so no values leak). Attached to errors to give them context. */
  TelemetryClient.prototype._crumb = function (name) {
    this.crumbs.push(name);
    if (this.crumbs.length > MAX_CRUMBS) this.crumbs.shift();
  };

  /* Capture uncaught errors + unhandled rejections as app_error events. Hard rules:
   * the reporter NEVER throws, caps at 10 errors/min/device, dedups an identical
   * message once/min, and caps the stack length. */
  TelemetryClient.prototype._hookErrors = function () {
    if (typeof window === "undefined") return;
    var self = this;
    var times = [];
    var seen = {};
    function report(message, stack, extra) {
      try {
        var now = Date.now();
        times = times.filter(function (t) {
          return now - t < 60000;
        });
        if (times.length >= 10) return;
        var sig = String(message).slice(0, 200);
        if (seen[sig] && now - seen[sig] < 60000) return;
        seen[sig] = now;
        times.push(now);
        // prune the dedup map - a long-lived tab with many distinct error messages
        // must not grow it forever (entries older than the 60s window are dead weight)
        var keys = Object.keys(seen);
        if (keys.length > 50) {
          for (var i = 0; i < keys.length; i++) {
            if (now - seen[keys[i]] >= 60000) delete seen[keys[i]];
          }
        }
        var props = Object.assign(
          {
            message: String(message).slice(0, 500),
            url: (typeof location !== "undefined" && location.pathname) || "",
            crumbs: self.crumbs.join(" > ").slice(0, CRUMBS_CAP),
          },
          extra || {},
        );
        if (stack) props.stack = String(stack).slice(0, 4000);
        self.track("app_error", props);
        self.flush(); // the page may be dying - don't wait for the timer
      } catch (e) {
        /* never throw from the error reporter */
      }
    }
    this._report = report; // shared with the fetch hook and reportError()
    window.addEventListener("error", function (ev) {
      // resource-load errors (img/script tags: ev.target set, no ev.error) are
      // skipped - they're network noise, not app bugs.
      if (!ev || (!ev.error && !ev.message)) return;
      report(
        ev.message || (ev.error && ev.error.message) || "unknown error",
        ev.error && ev.error.stack,
        { line: ev.lineno || 0, col: ev.colno || 0, src: String(ev.filename || "").slice(0, 300) },
      );
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      report((r && r.message) || String(r || "unhandled rejection"), r && r.stack, { kind: "promise" });
    });
  };

  /* Optionally report fetches that fail with a network error or a >=500 response.
   * Pathname only, never the query string. Your telemetry endpoint is excluded so a
   * flush failure can't report itself. Enable with init({ fetchErrors: true }). */
  TelemetryClient.prototype._hookFetch = function () {
    if (typeof window === "undefined" || !window.fetch || !this._report) return;
    var self = this;
    var orig = window.fetch;
    function pathOf(input) {
      try {
        var u = typeof input === "string" ? input : (input && input.url) || "";
        return new URL(u, location.href).pathname.slice(0, 300);
      } catch (e) {
        return "";
      }
    }
    window.fetch = function (input, init) {
      var p = pathOf(input);
      var skip = !p || (self.cfg && self.cfg.endpoint && String(self.cfg.endpoint).indexOf(p) !== -1);
      return orig.apply(this, arguments).then(
        function (res) {
          if (!skip && res && res.status >= 500) {
            self._report("fetch failed: " + res.status + " " + p, null, { kind: "fetch", status: res.status });
          }
          return res;
        },
        function (err) {
          if (!skip) self._report("fetch network error: " + p, err && err.stack, { kind: "fetch" });
          throw err;
        },
      );
    };
  };

  /* Report a CAUGHT error through the same app_error pipe the global hooks use,
   * sharing their rate-limit + dedup state. Use it where you swallow your own errors
   * (e.g. a retry loop that catches every failure - those never reach window.onerror):
   *   Telemetry.reportError('[sync] push failed: ' + msg, err.stack, { kind: 'sync' });
   * No-op under init({ errors: false }). Never throws. */
  TelemetryClient.prototype.reportError = function (message, stack, extra) {
    try {
      if (this._report) this._report(message, stack, extra || {});
    } catch (e) {
      /* never throw */
    }
  };

  /* Attach a hashed user id. Pass a raw id; this SHA-256s it so no raw id leaves the
   * device. Skipped (rather than sending raw) if SubtleCrypto is unavailable. */
  TelemetryClient.prototype.identifyUser = async function (rawId) {
    if (!rawId) return;
    try {
      var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(rawId)));
      this.userHash = Array.from(new Uint8Array(buf))
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    } catch (e) {
      /* subtle unavailable - skip identity rather than ship raw */
    }
  };

  TelemetryClient.prototype.track = function (event, props) {
    if (!this.ready) {
      this.log("track before init", event);
      return;
    }
    this.touchSession();
    if (event !== "app_error") {
      this._crumb(event === "screen_view" && props && props.screen ? "screen:" + props.screen : event);
    }
    var e = {
      event_id: uuid(),
      app_id: this.cfg.appId,
      anon_id: this.anonId,
      user_hash: this.userHash,
      session_id: this.sessionId,
      event: event,
      props: props || {},
      platform: this.cfg.platform,
      app_version: this.cfg.appVersion,
      schema_version: SCHEMA_VERSION,
      occurred_at: new Date().toISOString(),
    };
    this.queue.push(e);
    if (this.queue.length > MAX_QUEUE) this.queue = this.queue.slice(this.queue.length - MAX_QUEUE);
    this.persist();
    if (this.queue.length >= this.cfg.maxBatch) this.flush();
  };

  /* Fire an event at most once ever (per device) - for activation milestones. */
  TelemetryClient.prototype.trackOnce = function (flagKey, event, props) {
    var k = "tl_once_" + flagKey;
    if (this.cfg.storage.getItem(k)) return;
    this.cfg.storage.setItem(k, "1");
    this.track(event, props);
  };

  TelemetryClient.prototype.screen = function (name, props) {
    this.track("screen_view", Object.assign({ screen: name }, props || {}));
  };

  TelemetryClient.prototype.flush = function () {
    if (!this.queue.length || !this.cfg) return;
    // Single flush in flight at a time: the interval timer, visibilitychange, and the
    // maxBatch trigger can all fire together - two overlapping flushes each sliced the
    // same front of the queue, and the second success removed events that were NEVER
    // sent (silent data loss). Events queued meanwhile go out on the next tick.
    if (this._inflight) return;
    this._inflight = true;
    var batch = this.queue.slice(0, this.cfg.maxBatch);
    var self = this;
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl
      ? setTimeout(function () {
          ctrl.abort();
        }, FLUSH_TIMEOUT_MS)
      : null;
    return fetch(this.cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true, // survive page unload - the dying-page error flush must land
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("ingest " + res.status);
        // remove exactly what was SENT (by event_id, not by position) - track() may
        // have pushed new events, or the cap may have trimmed the front, mid-flight.
        var sent = {};
        for (var i = 0; i < batch.length; i++) sent[batch[i].event_id] = 1;
        self.queue = self.queue.filter(function (e) {
          return !sent[e.event_id];
        });
        self.persist();
        self.log("flushed", batch.length);
      })
      .catch(function (err) {
        self.log("flush failed (kept in queue)", String(err)); // offline -> retry next tick
      })
      .finally(function () {
        self._inflight = false;
        if (timer) clearTimeout(timer);
      });
  };

  TelemetryClient.prototype.newSession = function () {
    this.sessionId = uuid();
    this.lastActivity = Date.now();
  };
  TelemetryClient.prototype.touchSession = function () {
    if (Date.now() - this.lastActivity > SESSION_GAP_MS) this.newSession();
    this.lastActivity = Date.now();
  };
  TelemetryClient.prototype.persist = function () {
    var ok = this.cfg.storage.setItem(KEY_QUEUE, JSON.stringify(this.queue));
    // surface a persist failure ONCE (quota / private mode): the queue still works in
    // memory, but a reload loses it - that must be visible in the pipe, not silent.
    if (ok === false && !this._persistWarned) {
      this._persistWarned = true; // set BEFORE track() - its persist() call re-enters here
      this.log("persist failed (storage quota?) - queue is memory-only this session");
      try {
        this.track("app_error", { message: "telemetry: persist failed (storage quota?)", kind: "storage" });
      } catch (e) {}
    }
  };
  TelemetryClient.prototype.log = function () {
    if (this.cfg && this.cfg.debug) {
      var a = ["[telemetry]"].concat([].slice.call(arguments));
      console.log.apply(console, a);
    }
  };

  var instance = new TelemetryClient();
  if (typeof window !== "undefined") window.Telemetry = instance;
  if (typeof module !== "undefined" && module.exports) module.exports = instance;
})();
