#!/usr/bin/env node
// telemetry-lite - minimal self-host ingest endpoint (zero dependencies).
//
// A reference receiver so you can run the whole loop locally: it accepts the
// POST { events: [...] } batches the SDK sends, prints them, and appends them to
// events.ndjson. Swap this for your real backend (a function, a queue, a DB insert)
// in production - the only contract the SDK needs is "respond 2xx when you've durably
// accepted the batch; respond non-2xx (or fail) and the SDK keeps the events to retry."
//
//   node server/ingest.mjs            # listens on http://localhost:8787/events
//   PORT=9000 node server/ingest.mjs  # custom port
//
// CORS is wide-open here for easy local testing. Lock it to your origins in production.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8787;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "events.ndjson");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST" || !req.url.startsWith("/events")) return send(res, 404, { error: "POST /events" });

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 1_000_000) req.destroy(); // basic body cap
  });
  req.on("end", () => {
    let events;
    try {
      events = JSON.parse(raw).events;
    } catch {
      return send(res, 400, { error: "invalid json" });
    }
    if (!Array.isArray(events)) return send(res, 400, { error: "expected { events: [...] }" });

    // Persist durably BEFORE acking - only a 2xx tells the SDK it can drop these.
    const lines = events.map((e) => JSON.stringify(e)).join("\n");
    if (lines) fs.appendFileSync(OUT, lines + "\n");
    for (const e of events) console.log(`  ${e.occurred_at}  ${e.app_id}  ${e.event}  ${JSON.stringify(e.props)}`);

    send(res, 200, { ok: true, accepted: events.length });
  });
});

server.listen(PORT, () => {
  console.log(`telemetry-lite ingest listening on http://localhost:${PORT}/events`);
  console.log(`appending batches to ${OUT}`);
});
