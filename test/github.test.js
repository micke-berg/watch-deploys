// GitHub adapter: the neutral health mappings + URL building (pure, no network).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const gh = require("../providers/github.js");

test("runHealth: completed conclusions map to ok/failed", () => {
  assert.equal(gh.runHealth("completed", "success"), "ok");
  assert.equal(gh.runHealth("completed", "skipped"), "ok");
  assert.equal(gh.runHealth("completed", "neutral"), "ok");
  assert.equal(gh.runHealth("completed", "failure"), "failed");
  assert.equal(gh.runHealth("completed", "cancelled"), "failed");
  assert.equal(gh.runHealth("completed", "timed_out"), "failed");
});

test("runHealth: in-flight statuses", () => {
  assert.equal(gh.runHealth("in_progress", null), "running");
  assert.equal(gh.runHealth("queued", null), "queued");
  assert.equal(gh.runHealth("waiting", null), "queued");
  assert.equal(gh.runHealth("", null), "none");
});

test("deployHealth: deployment states map to neutral health", () => {
  assert.equal(gh.deployHealth("success"), "ok");
  assert.equal(gh.deployHealth("failure"), "failed");
  assert.equal(gh.deployHealth("error"), "failed");
  assert.equal(gh.deployHealth("in_progress"), "running");
  assert.equal(gh.deployHealth("queued"), "queued");
  assert.equal(gh.deployHealth("pending"), "queued");
  assert.equal(gh.deployHealth("inactive"), "ok"); // superseded; drift covers "behind"
  assert.equal(gh.deployHealth(""), "none");
});

test("targetUrl: builds the right github.com page per kind", () => {
  assert.equal(
    gh.targetUrl({ kind: "pipeline", repository: "owner/repo", workflow: "ci.yml" }),
    "https://github.com/owner/repo/actions/workflows/ci.yml"
  );
  assert.equal(
    gh.targetUrl({ kind: "pipeline", repository: "owner/repo", workflow: ".github/workflows/deploy.yml" }),
    "https://github.com/owner/repo/actions/workflows/deploy.yml"
  );
  assert.equal(gh.targetUrl({ kind: "environment", repository: "owner/repo", name: "production" }), "https://github.com/owner/repo/deployments");
  assert.equal(gh.targetUrl({ kind: "release", repository: "owner/repo" }), "https://github.com/owner/repo/releases");
});
