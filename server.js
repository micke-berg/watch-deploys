// Tiny zero-dependency static server for the watch-deploys dashboard.
// Serves index.html + state.json on localhost, and exposes a few local endpoints:
//   GET  /status         resident-poller liveness (so the page can show "live")
//   GET  /config         safe presentation config (attribution, drift threshold)
//   POST /check          re-poll the host on demand (read-only; refreshes each card)
//   POST /watch          add a target — the agentic seam (a hook/CI step can drive it)
//   POST /dismiss        remove a card from the board (local only; never touches the host)
//
// There is NO AI anywhere in this app (decided). Every endpoint is read-only against the
// CI/CD host; the only writes are to the local state file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { runCheck, pollIfDue, registerTarget } = require("./check.js");
const config = require("./config.js");

const PORT = process.env.WATCH_DEPLOYS_PORT || config.port;
const ROOT = __dirname;
const STATE = path.join(ROOT, "state.json");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { watching: [], dismissed: [] }; throw e; }
}
function writeState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}

// /check — re-poll the host now (read-only) and return the fresh state for the dashboard.
async function handleCheck(res) {
  try {
    const { state, results } = await runCheck({ loop: false });
    const errors = results.filter((r) => r.error).map((r) => `${r.key}: ${r.error}`);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(Object.assign({}, state, errors.length ? { _checkErrors: errors } : {})));
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// /watch — add a target (the agentic seam). Query params:
//   kind=pipeline|environment|release  repo=owner/repo (optional; falls back to defaultRepository)
//   workflow=<file-or-name>  (pipeline)   name=<env>  (environment)   branch=<ref>  (pipeline, optional)
async function handleWatch(res, q) {
  const spec = {
    kind: q.get("kind") || "pipeline",
    repository: q.get("repo") || q.get("repository") || "",
    workflow: q.get("workflow") || "",
    name: q.get("name") || "",
    branch: q.get("branch") || "",
  };
  try {
    const out = await registerTarget(spec);
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "couldn't add target — " + (e.message || "not found or not accessible") });
  }
}

// /dismiss — remove one card by its key, and remember the dismissal so a config/discovery
// seed doesn't immediately re-add it. Local only; never touches the host.
function handleDismiss(res, key) {
  if (!key) return sendJson(res, 400, { ok: false, error: "missing key" });
  let state;
  try { state = readState(); }
  catch (e) { return sendJson(res, 500, { ok: false, error: "cannot read state.json: " + e.message }); }
  const before = (state.watching || []).length;
  state.watching = (state.watching || []).filter((t) => t.key !== key);
  const removed = before - state.watching.length;
  if (!removed) return sendJson(res, 404, { ok: false, error: `not watching ${key}` });
  state.dismissed = Array.from(new Set([...(state.dismissed || []), key]));
  writeState(state);
  sendJson(res, 200, { ok: true, removed, watching: state.watching });
}

// ── Resident poller ─────────────────────────────────────────────────────────────
// While server.js runs, THIS process is the watcher: it polls the host on the shared cadence
// and fires check.js's desktop/phone notifications — no editor/agent needed. It ticks every
// HEARTBEAT_MS but only reaches the host when state.nextPollAt says it is due (faster while a
// run/deploy is in flight, slower when everything is settled), so an idle tick is a tiny
// state.json read and nothing else.
const HEARTBEAT_MS = 30 * 1000;
const poller = { startedAt: new Date().toISOString(), lastPollAt: null, nextPollAt: null, active: 0, watching: 0, lastError: null };
let pollTimer = null;

async function pollTick() {
  try {
    const r = await pollIfDue();
    poller.active = r.active;
    poller.watching = r.watching != null ? r.watching : poller.watching;
    poller.nextPollAt = r.nextPollAt || null;
    if (r.polled) poller.lastPollAt = new Date().toISOString();
    poller.lastError = null;
  } catch (e) {
    poller.lastError = e.message;
    console.error("poll tick failed:", e.message);
  } finally {
    pollTimer = setTimeout(pollTick, HEARTBEAT_MS);
  }
}

function handleStatus(res) {
  let watching = 0;
  try { watching = (readState().watching || []).length; } catch (e) { /* ignore */ }
  sendJson(res, 200, {
    alive: true, watching, active: poller.active,
    lastPollAt: poller.lastPollAt, nextPollAt: poller.nextPollAt,
    startedAt: poller.startedAt, lastError: poller.lastError,
  });
}

// Presentation-relevant config for the page, so the dashboard stays config-driven and
// portable rather than hardcoding one person's values.
function handleConfig(res) {
  sendJson(res, 200, {
    builtBy: config.builtBy || "",
    builtByUrl: config.builtByUrl || "",
    provider: config.provider || "github",
    defaultRepository: config.defaultRepository || "",
    driftWarnCommits: Math.max(1, config.driftWarnCommits || 1),
  });
}

// The server binds to 127.0.0.1, but a browser on this machine can still reach it — so these
// guards keep a malicious web page from driving it:
//   hostAllowed  — the Host header must be a localhost name. Blocks DNS-rebinding, where an
//                  attacker domain resolves to 127.0.0.1 and its page talks to us.
//   csrfSafe     — state-changing endpoints must be POST and not a cross-site browser request.
//                  A cross-origin fetch/form sends Origin; a sub-resource GET (<img>/<script>)
//                  sends no Origin but does send Sec-Fetch-Site, so we check both and require
//                  POST (which <img>/<script> can't issue).
// Local CLI use (curl, a git hook) sends neither header and is unaffected.
function hostAllowed(req) {
  const host = (req.headers.host || "").toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host);
}
function csrfSafe(req) {
  if (req.method !== "POST") return false; // mutations are POST-only; blocks <img>/GET CSRF
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false; // cross-site browser req
  const origin = req.headers.origin;
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (!(h === "localhost" || h === "127.0.0.1" || h === "::1")) return false;
    } catch (e) { return false; } // malformed Origin => hostile
  }
  return true;
}
const MUTATING = new Set(["/check", "/watch", "/dismiss"]);
// Never serve config.json via the static handler even though it lives in ROOT — it can hold
// the ntfyTopic. (state.json is intentionally served: it is the dashboard's data feed.)
const BLOCKED_FILES = new Set(["config.json"]);

// Resolve a request URL to a servable file under ROOT, or an error status. Pure and exported
// so the path-traversal / blocked-file rules are unit-testable without a socket.
function staticFileFor(rawUrl) {
  const urlPath = String(rawUrl || "").split("?")[0];
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return { status: 400 }; }
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  // Must resolve strictly inside ROOT. ROOT + path.sep (not bare ROOT) so a sibling dir whose
  // name merely starts with ROOT can't be served.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return { status: 403 };
  if (BLOCKED_FILES.has(path.basename(file).toLowerCase())) return { status: 404 };
  return { status: 200, file };
}

function requestHandler(req, res) {
  if (!hostAllowed(req)) { res.writeHead(403); return res.end("forbidden host"); }
  const url = req.url.split("?")[0];
  if (MUTATING.has(url) && !csrfSafe(req)) { res.writeHead(403); return res.end("blocked"); }
  if (url === "/status") return handleStatus(res);
  if (url === "/config") return handleConfig(res);
  if (url === "/check") return handleCheck(res);
  if (url === "/watch") return handleWatch(res, new URLSearchParams(req.url.split("?")[1] || ""));
  if (url === "/dismiss") {
    const q = new URLSearchParams(req.url.split("?")[1] || "");
    return handleDismiss(res, q.get("key"));
  }

  const resolved = staticFileFor(req.url);
  if (resolved.status !== 200) {
    res.writeHead(resolved.status);
    return res.end(resolved.status === 400 ? "bad request" : resolved.status === 403 ? "forbidden" : "not found");
  }
  fs.readFile(resolved.file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(resolved.file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

// Only start the server + resident poller when run directly (node server.js). When required
// by a test, the module just exposes its functions with no side effects.
if (require.main === module) {
  const server = http.createServer(requestHandler);
  // The port is the singleton lock: only one dashboard can own it. A second start exits
  // cleanly here instead of crashing on EADDRINUSE — and never polls, so it can't race the
  // resident instance on state.json.
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.log(`watch-deploys: already running on http://localhost:${PORT} — nothing to do.`);
      process.exit(0);
    }
    throw e;
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`watch-deploys dashboard → http://localhost:${PORT}`);
    pollTick(); // now that we own the port: first seed + poll, then self-schedules
  });
}

module.exports = { hostAllowed, csrfSafe, staticFileFor, requestHandler };
