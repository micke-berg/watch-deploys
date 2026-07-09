// Core: the design-status derivation, the edge-triggered notification logic, target keys,
// spec validation, and that a freshly-seeded entry fires nothing for its existing state.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const check = require("../check.js");
const config = require("../config.js"); // same cached object check.js reads, so tests can pin it

// A neutral decoded snapshot with sensible defaults; override per test.
const decoded = (over = {}) => Object.assign({
  kind: "pipeline", name: "CI", health: "ok", state: "success", behindBy: null, base: "main",
  title: "t", ref: "main", sha: "abc1234def", shortSha: "abc1234", actor: "", number: 1,
  event: "push", createdAt: "", finishedAt: "", url: "https://x",
}, over);
const NOW = "2026-07-09T00:00:00.000Z";

test("statusKey: failed → kind-specific crit", () => {
  assert.equal(check.statusKey("pipeline", "failed", null), "pipeline_failed");
  assert.equal(check.statusKey("environment", "failed", null), "deploy_failed");
  assert.equal(check.statusKey("release", "failed", null), "deploy_failed");
});

test("statusKey: in-flight states", () => {
  assert.equal(check.statusKey("pipeline", "running", null), "running");
  assert.equal(check.statusKey("environment", "running", null), "deploying");
  assert.equal(check.statusKey("pipeline", "queued", null), "queued");
  assert.equal(check.statusKey("pipeline", "none", null), "idle");
});

test("statusKey: healthy → passing/current, drift → behind (threshold-aware)", () => {
  assert.equal(check.statusKey("pipeline", "ok", null), "passing");
  assert.equal(check.statusKey("environment", "ok", 0), "current");
  assert.equal(check.statusKey("environment", "ok", 3, 1), "behind");
  assert.equal(check.statusKey("release", "ok", 2, 1), "behind");
  assert.equal(check.statusKey("environment", "ok", 1, 2), "current"); // below the threshold
});

test("phaseFor: active while a run/deploy is in flight, else steady", () => {
  assert.equal(check.phaseFor(decoded({ health: "running" })), "active");
  assert.equal(check.phaseFor(decoded({ health: "queued" })), "active");
  assert.equal(check.phaseFor(decoded({ health: "ok" })), "steady");
  assert.equal(check.phaseFor(decoded({ health: "failed" })), "steady");
});

test("diffTarget: a pipeline failure fires exactly once (guarded by lastHealth)", () => {
  const t = { lastHealth: "ok", lastBehindBy: 0, lastState: "success" };
  const first = check.diffTarget(t, decoded({ kind: "pipeline", health: "failed", state: "failure" }), NOW, 1);
  assert.equal(first.actionNeeded.pipelineFailed, true);
  assert.equal(first.actionNeeded.deployFailed, false);
  const second = check.diffTarget(first.nextState, decoded({ kind: "pipeline", health: "failed", state: "failure" }), NOW, 1);
  assert.equal(second.actionNeeded.pipelineFailed, false);
});

test("diffTarget: a deploy failure uses the deploy edge, not the pipeline edge", () => {
  const t = { lastHealth: "ok", lastBehindBy: 0 };
  const r = check.diffTarget(t, decoded({ kind: "environment", health: "failed", state: "failure", behindBy: null }), NOW, 1);
  assert.equal(r.actionNeeded.deployFailed, true);
  assert.equal(r.actionNeeded.pipelineFailed, false);
});

test("diffTarget: 'behind' fires once when crossing the threshold, resets after a redeploy", () => {
  const t = { lastHealth: "ok", lastBehindBy: 0 };
  const drift = check.diffTarget(t, decoded({ kind: "environment", behindBy: 3 }), NOW, 1);
  assert.equal(drift.actionNeeded.behind, true);
  // steady while still behind → quiet
  const again = check.diffTarget(drift.nextState, decoded({ kind: "environment", behindBy: 3 }), NOW, 1);
  assert.equal(again.actionNeeded.behind, false);
  // redeployed (behindBy back to 0), then drifts again → fires again
  const redeployed = check.diffTarget(again.nextState, decoded({ kind: "environment", behindBy: 0 }), NOW, 1);
  const drift2 = check.diffTarget(redeployed.nextState, decoded({ kind: "environment", behindBy: 2 }), NOW, 1);
  assert.equal(drift2.actionNeeded.behind, true);
});

test("diffTarget: a steady tick reports no changes and no notifications", () => {
  const t = { lastHealth: "ok", lastBehindBy: 0, lastState: "success" };
  const r = check.diffTarget(t, decoded({ health: "ok", state: "success", behindBy: null }), NOW, 1);
  assert.equal(r.hasChanges, false);
  assert.equal(Object.values(r.actionNeeded).some(Boolean), false);
});

test("makeEntry: a freshly-seeded entry does NOT fire for its existing state", () => {
  // An already-red pipeline added to the board must not immediately notify.
  const spec = { kind: "pipeline", repository: "o/r", workflow: "ci.yml", branch: "main" };
  const entry = check.makeEntry(spec, decoded({ kind: "pipeline", health: "failed", state: "failure" }), NOW);
  const r = check.diffTarget(entry, decoded({ kind: "pipeline", health: "failed", state: "failure" }), NOW, 1);
  assert.equal(r.actionNeeded.pipelineFailed, false);
  // Same for a target that is already behind at registration time.
  const envSpec = { kind: "environment", repository: "o/r", name: "production" };
  const envEntry = check.makeEntry(envSpec, decoded({ kind: "environment", health: "ok", behindBy: 5 }), NOW);
  const er = check.diffTarget(envEntry, decoded({ kind: "environment", health: "ok", behindBy: 5 }), NOW, 1);
  assert.equal(er.actionNeeded.behind, false);
});

test("targetKey: stable + unique per kind/repo/name", () => {
  assert.equal(check.targetKey({ kind: "pipeline", repository: "o/r", workflow: "ci.yml", branch: "main" }), "pipeline:o/r:ci.yml@main");
  assert.equal(check.targetKey({ kind: "environment", repository: "o/r", name: "production" }), "environment:o/r:production");
  assert.equal(check.targetKey({ kind: "release", repository: "o/r" }), "release:o/r");
});

test("normalizeSpec: fills + validates, throws on bad specs", () => {
  const ok = check.normalizeSpec({ kind: "pipeline", repository: "o/r", workflow: "ci.yml" });
  assert.equal(ok.kind, "pipeline");
  assert.throws(() => check.normalizeSpec({ kind: "banana", repository: "o/r" }), /unknown target kind/);
  assert.throws(() => check.normalizeSpec({ kind: "pipeline", repository: "o/r" }), /needs a workflow/);
  assert.throws(() => check.normalizeSpec({ kind: "environment", repository: "o/r" }), /needs a name/);
  // The "needs a repository" path depends on defaultRepository; pin it empty so the test is
  // deterministic whether or not the machine running it has a config.json.
  const saved = config.defaultRepository;
  config.defaultRepository = "";
  try {
    assert.throws(() => check.normalizeSpec({ kind: "pipeline", workflow: "ci.yml" }), /needs a repository/);
  } finally {
    config.defaultRepository = saved;
  }
});

test("isWatched: matches by key", () => {
  const state = { watching: [{ key: "pipeline:o/r:ci.yml@main" }] };
  assert.equal(check.isWatched(state, "pipeline:o/r:ci.yml@main"), true);
  assert.equal(check.isWatched(state, "environment:o/r:production"), false);
  assert.equal(check.isWatched({}, "x"), false);
});
