// check.js — the deterministic poll + decode core for the watch-deploys system.
//
// Provider-agnostic core. All host-specific work (talking to the CI/CD host, decoding its
// run status / deployment state / release drift) lives behind a provider adapter in
// providers/<host>.js; this file only ever sees the neutral decoded snapshot. That seam
// keeps the dashboard and the resident poller from drifting and lets a new host be one file.
//
// A "card" is one target: a `pipeline` (a workflow's latest run on a branch), an
// `environment` (the latest deployment + how far it has fallen behind the default branch),
// or a `release` (the latest published release + the same drift). The core turns the neutral
// snapshot into the design status, the sort order, and the edge-triggered notifications.
//
// CLI:
//   node check.js          refresh each card's display block, write state.json, print a summary
//   node check.js --loop   also diff vs the last-seen fields, fire notifications, print JSON deltas
//                          (this is what an external watcher/agent tick would run)

const fs = require("fs");
const path = require("path");

const config = require("./config.js");
const { notify } = require("./notify.js"); // cross-platform desktop + optional phone push
// The provider adapter is the seam: it decodes to the neutral snapshot and builds card URLs.
// Which adapter loads is config-driven, so the core stays host-agnostic. The map is a
// whitelist so config can't require an arbitrary path.
const PROVIDERS = { github: "./providers/github.js", azure: "./providers/azure.js" };
const provider = require(PROVIDERS[config.provider] || PROVIDERS.github);
const ROOT = __dirname;
const STATE = path.join(ROOT, "state.json");

const DRIFT_WARN = Math.max(1, config.driftWarnCommits || 1); // commits behind = the "behind" edge

// Read local state, tolerating first run: a fresh clone has no state.json (it's gitignored),
// so a missing file is the empty watch list, not an error. Corrupt JSON still throws.
function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return { watching: [], dismissed: [] }; throw e; }
  const s = JSON.parse(raw);
  s.watching = s.watching || [];
  s.dismissed = s.dismissed || [];
  return s;
}
// The one place state is written, so every writer is consistent.
function saveState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}

const shortRepo = (repo) => String(repo || "").split("/").pop() || repo || "";

// A stable, unique id for a target within the watch list. ids are per (kind, repo, name/
// workflow/branch) so the same environment or pipeline is never watched twice.
function targetKey(t) {
  const repo = t.repository || config.defaultRepository || "";
  if (t.kind === "environment") return `environment:${repo}:${t.name}`;
  if (t.kind === "release") return `release:${repo}`;
  return `pipeline:${repo}:${t.workflow || ""}@${t.branch || config.branch || "default"}`;
}
const targetName = (t) => t.name || t.workflow || t.kind || "target";

// The single most-important design status for a card, from the neutral snapshot. Drives both
// the colour/label (statusMeta in app.js) and the sort + "needs you" count. Pure + exported so
// it is unit-testable and the one source of truth the display block carries to the UI.
function statusKey(kind, health, behindBy, driftWarn) {
  const warn = driftWarn || DRIFT_WARN;
  if (health === "failed") return kind === "pipeline" ? "pipeline_failed" : "deploy_failed";
  if (health === "running") return kind === "pipeline" ? "running" : "deploying";
  if (health === "queued") return "queued";
  if (health === "none") return "idle";
  // health === "ok"
  if (behindBy != null && behindBy >= warn) return "behind";
  return kind === "pipeline" ? "passing" : "current";
}

// A target is "active" (poll it on the fast cadence) while something is in flight.
function phaseFor(decoded) {
  return decoded.health === "running" || decoded.health === "queued" ? "active" : "steady";
}
const isActiveEntry = (t) => t.display && (t.display.health === "running" || t.display.health === "queued");

// The presentation block the dashboard renders. Everything the UI needs, nothing host-specific.
function buildDisplay(target, d, nowIso) {
  return {
    kind: d.kind,
    name: d.name || targetName(target),
    repository: target.repository || "",
    health: d.health,
    status: statusKey(d.kind, d.health, d.behindBy, DRIFT_WARN),
    state: d.state || "",
    behindBy: d.behindBy == null ? null : d.behindBy,
    base: d.base || "",
    title: d.title || "",
    ref: d.ref || "",
    sha: d.sha || "",
    shortSha: d.shortSha || "",
    actor: d.actor || "",
    number: d.number == null ? null : d.number,
    event: d.event || "",
    createdAt: d.createdAt || "",
    finishedAt: d.finishedAt || "",
    url: d.url || provider.targetUrl(target),
    updatedAt: nowIso,
  };
}

// Diff fresh data vs the target's stored last-seen fields. Returns changes + notification
// hints (edge-triggered, each fires once) + the next last-seen state.
function diffTarget(target, d, nowIso, driftWarn) {
  const warn = driftWarn || DRIFT_WARN;
  const lastHealth = target.lastHealth || "";
  const lastBehind = target.lastBehindBy || 0;
  const behind = d.behindBy == null ? 0 : d.behindBy;

  const changes = {
    health: d.health !== lastHealth ? { from: lastHealth, to: d.health } : null,
    behind: behind !== lastBehind ? { from: lastBehind, to: behind } : null,
    state: d.state !== (target.lastState || "") ? { from: target.lastState || "", to: d.state } : null,
  };

  const isDeploy = d.kind !== "pipeline";
  const actionNeeded = {
    // Fire once on the transition INTO the bad state (guarded by lastHealth), so a steady red
    // doesn't re-ping; a recovery-then-fail correctly fires again.
    pipelineFailed: d.kind === "pipeline" && d.health === "failed" && lastHealth !== "failed",
    deployFailed: isDeploy && d.health === "failed" && lastHealth !== "failed",
    // Fire once when a target first crosses the drift threshold; resets when it's redeployed
    // (behindBy back below the threshold), so the next drift pings again.
    behind: d.behindBy != null && d.behindBy >= warn && lastBehind < warn,
  };

  const nextState = {
    lastHealth: d.health,
    lastBehindBy: behind,
    lastState: d.state,
    lastTickAt: nowIso,
  };
  const hasChanges = !!(changes.health || changes.behind || changes.state);
  return { changes, actionNeeded, nextState, phase: phaseFor(d), hasChanges };
}

// Validate + fill a target spec (from config.targets, /watch, or discovery). Throws on a bad
// spec so a typo surfaces instead of silently watching nothing.
function normalizeSpec(spec) {
  const s = Object.assign({}, spec);
  s.kind = (s.kind || "pipeline").toLowerCase();
  if (!["pipeline", "environment", "release"].includes(s.kind)) throw new Error(`unknown target kind "${s.kind}"`);
  s.repository = String(s.repository || config.defaultRepository || "").trim();
  if (!s.repository) throw new Error("target needs a repository (set it on the target or as defaultRepository)");
  if (s.kind === "pipeline" && !s.workflow) throw new Error("a pipeline target needs a workflow (file name or workflow name)");
  if (s.kind === "environment" && !s.name) throw new Error("an environment target needs a name");
  return s;
}

// Build a fully-seeded watch entry from a decoded target. Every last-seen field is set to the
// current situation so the target does NOT fire notifications for its existing state — only
// for future changes. Pure (no I/O), so registerTarget, config seeding, and discovery share it.
function makeEntry(spec, d, nowIso) {
  const entry = {
    kind: d.kind,
    repository: spec.repository,
    workflow: spec.workflow || "",
    name: spec.name || "",
    branch: spec.branch || "",
    key: targetKey(spec),
    lastHealth: d.health,
    lastBehindBy: d.behindBy == null ? 0 : d.behindBy,
    lastState: d.state,
    lastTickAt: nowIso,
  };
  entry.display = buildDisplay(entry, d, nowIso);
  return entry;
}

function isWatched(state, key) {
  return (state.watching || []).some((t) => t.key === key);
}

// Deterministic notification, delegated to the cross-platform notifier. Fire-and-forget.
function fireNotify(title, message) {
  try { notify(title, message); } catch (e) { /* best-effort */ }
}

async function refreshAll(state, opts) {
  const loop = !!(opts && opts.loop);
  const nowIso = new Date().toISOString();
  const results = [];
  await Promise.all(
    (state.watching || []).map(async (t) => {
      try {
        const d = await provider.decodeTarget(t);
        t.display = buildDisplay(t, d, nowIso);
        t.error = "";
        if (loop) {
          const { changes, actionNeeded, nextState, hasChanges } = diffTarget(t, d, nowIso, DRIFT_WARN);
          Object.assign(t, nextState);
          const an = actionNeeded, name = t.display.name, repo = shortRepo(t.repository);
          if (an.pipelineFailed) fireNotify("Pipeline red", `${name} (${repo}): latest run on ${t.display.base || t.display.ref} failed`);
          if (an.deployFailed)   fireNotify("Deploy failed", `${name} (${repo}): deploy failed`);
          if (an.behind)         fireNotify("Behind", `${name} (${repo}): ${d.behindBy} commit${d.behindBy === 1 ? "" : "s"} behind ${t.display.base}`);
          results.push({ key: t.key, name, hasChanges, changes, actionNeeded, display: t.display });
        } else {
          results.push({ key: t.key, name: t.display.name, display: t.display });
        }
      } catch (e) {
        t.error = e.message; // keep the last good display (if any); surface the error
        results.push({ key: t.key, error: e.message });
      }
    })
  );

  let suggestedDelaySeconds = null;
  if ((state.watching || []).length) {
    suggestedDelaySeconds = (state.watching || []).some(isActiveEntry) ? config.cadence.activeSeconds : config.cadence.steadySeconds;
  }
  return { state, results, suggestedDelaySeconds };
}

// Add a target to the watch list. Enriches from the host so the card renders right away.
// Read-only against the host; the only write is the local state file. Un-dismisses the key
// (a manual add overrides a previous ✕).
async function registerTarget(spec) {
  const s = normalizeSpec(spec);
  const key = targetKey(s);
  const state = loadState();
  state.dismissed = (state.dismissed || []).filter((k) => k !== key);
  if (isWatched(state, key)) { saveState(state); return { added: false, reason: "already watching", key }; }
  const d = await provider.decodeTarget(s); // throws if the target can't be read
  state.watching.push(makeEntry(s, d, new Date().toISOString()));
  state.nextPollAt = ""; // let the resident poller re-evaluate cadence next tick
  saveState(state);
  return { added: true, key };
}

// Ensure every config.targets entry is on the board (declarative watch list). Skips ones the
// user dismissed with the ✕. Best-effort: a decode failure is swallowed and retried next tick.
async function syncConfigTargets(state) {
  const specs = Array.isArray(config.targets) ? config.targets : [];
  const dismissed = new Set(state.dismissed || []);
  const nowIso = new Date().toISOString();
  let added = 0;
  for (const raw of specs) {
    let s; try { s = normalizeSpec(raw); } catch (e) { continue; }
    const key = targetKey(s);
    if (isWatched(state, key) || dismissed.has(key)) continue;
    try { state.watching.push(makeEntry(s, await provider.decodeTarget(s), nowIso)); added++; }
    catch (e) { /* skip; a later tick retries */ }
  }
  return added;
}

// Auto-discover a repo's watchable targets (config.autoDiscover) via the provider. Adds any
// not already watched or dismissed. No-op unless enabled and the provider supports it.
async function discover(state) {
  if (!config.autoDiscover || typeof provider.discoverTargets !== "function") return 0;
  const repo = config.autoDiscoverRepository || config.defaultRepository;
  if (!repo) return 0;
  let specs;
  try { specs = await provider.discoverTargets(repo); } catch (e) { return 0; }
  const dismissed = new Set(state.dismissed || []);
  const nowIso = new Date().toISOString();
  let added = 0;
  for (const raw of specs || []) {
    let s; try { s = normalizeSpec(raw); } catch (e) { continue; }
    const key = targetKey(s);
    if (isWatched(state, key) || dismissed.has(key)) continue;
    try { state.watching.push(makeEntry(s, await provider.decodeTarget(s), nowIso)); added++; }
    catch (e) { /* skip; a later tick retries */ }
  }
  return added;
}

// Any declarative source that should keep re-checking even on an empty board?
function seedingOn() {
  return (Array.isArray(config.targets) && config.targets.length > 0) || !!config.autoDiscover;
}
// Run every seeding source, in place. Returns how many were added.
async function seed(state) {
  let added = await syncConfigTargets(state);
  added += await discover(state);
  if (added) state.nextPollAt = "";
  return added;
}

async function runCheck(opts) {
  const state = loadState();
  await seed(state);
  const out = await refreshAll(state, opts);
  if (opts && opts.loop) {
    out.state.nextPollAt = out.suggestedDelaySeconds
      ? new Date(Date.now() + out.suggestedDelaySeconds * 1000).toISOString()
      : "";
  }
  saveState(out.state);
  return out;
}

// Resident-poller entry point (used by server.js). Polls the host only when the shared cadence
// (state.nextPollAt) says it's due; otherwise it idles with zero host calls. Because check.js's
// notifications are edge-triggered (fire once), a resident poller and an external --loop tick
// can run at once without double-notifying.
async function pollIfDue(opts) {
  const force = !!(opts && opts.force);
  const state = loadState();
  const now = Date.now();
  const due = force || !state.nextPollAt || now >= Date.parse(state.nextPollAt);

  // Seed on the poll cadence, never on every heartbeat, so discovery doesn't turn an idle
  // machine into a per-minute search.
  if (due) await seed(state);

  const inFlight = (state.watching || []).filter(isActiveEntry).length;

  if (!(state.watching || []).length) {
    let changed = false;
    if (due && seedingOn()) { // keep re-checking for new targets even while the board is empty
      state.nextPollAt = new Date(now + config.cadence.steadySeconds * 1000).toISOString();
      changed = true;
    }
    if (changed) saveState(state);
    return { polled: false, idle: true, active: 0, watching: 0, nextPollAt: state.nextPollAt || "" };
  }
  if (!due) {
    return { polled: false, notDue: true, active: inFlight, watching: state.watching.length, nextPollAt: state.nextPollAt };
  }

  const out = await refreshAll(state, { loop: true });
  out.state.nextPollAt = out.suggestedDelaySeconds
    ? new Date(now + out.suggestedDelaySeconds * 1000).toISOString()
    : "";
  saveState(out.state);
  return {
    polled: true,
    active: (out.state.watching || []).filter(isActiveEntry).length,
    watching: out.state.watching.length,
    nextPollAt: out.state.nextPollAt,
    suggestedDelaySeconds: out.suggestedDelaySeconds,
    results: out.results,
  };
}

module.exports = {
  runCheck, refreshAll, decodeTarget: provider.decodeTarget, pollIfDue, registerTarget,
  syncConfigTargets, discover, seed,
  // pure helpers (unit-tested):
  targetKey, statusKey, phaseFor, diffTarget, normalizeSpec, makeEntry, isWatched,
};

// CLI
if (require.main === module) {
  const loop = process.argv.includes("--loop");
  runCheck({ loop })
    .then((out) => {
      if (loop) {
        console.log(JSON.stringify({ suggestedDelaySeconds: out.suggestedDelaySeconds, results: out.results }, null, 2));
      } else {
        console.log(
          out.results
            .map((r) => {
              if (r.error) return `${r.key}: ERROR ${r.error}`;
              const d = r.display;
              const drift = d.behindBy != null && d.behindBy > 0 ? `, ${d.behindBy} behind ${d.base}` : "";
              return `${d.kind} ${d.name} (${shortRepo(d.repository)}): ${d.status}${drift}${d.shortSha ? " @" + d.shortSha : ""}`;
            })
            .join("\n") || "(nothing being watched — set targets in config.json)"
        );
      }
    })
    .catch((e) => { console.error("check failed: " + e.message); process.exit(1); });
}
