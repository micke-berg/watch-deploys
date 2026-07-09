// Azure adapter (honest stub): the real shell-safety validators + URL builder are exercised,
// and the two data functions must reject with the "not implemented yet" message — never fake data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const az = require("../providers/azure.js");

test("assertSafeId accepts numeric ids, rejects everything else", () => {
  az.assertSafeId(123);
  az.assertSafeId("42");
  assert.throws(() => az.assertSafeId("1; calc"));
  assert.throws(() => az.assertSafeId("abc"));
  assert.throws(() => az.assertSafeId(""));
});

test("assertSafeName accepts normal names, rejects shell metacharacters", () => {
  az.assertSafeName("production");
  az.assertSafeName("Build & Deploy".replace("&", "and")); // sanity: normal words pass
  az.assertSafeName("ci.yml");
  az.assertSafeName("release/24.3");
  for (const bad of ["x;calc", "a && b", "a`b`", "a|b", "a$(x)", "a>b", 'a"b', "a\nb"]) {
    assert.throws(() => az.assertSafeName(bad), /invalid target name/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("assertSafeIdentity allows international names, rejects shell-breaking chars", () => {
  az.assertSafeIdentity("Björn O'Malley");
  assert.throws(() => az.assertSafeIdentity('a"b'));
  assert.throws(() => az.assertSafeIdentity("a`b`"));
});

test("targetUrl builds an Azure DevOps build/release URL (real, not a stub)", () => {
  const build = az.targetUrl({ kind: "pipeline", repository: "repo", workflow: "1" });
  assert.match(build, /_build$/);
  const rel = az.targetUrl({ kind: "environment", repository: "repo", name: "production" });
  assert.match(rel, /_release$/);
});

test("decodeTarget / discoverTargets reject with 'not implemented yet' — never fake data", async () => {
  await assert.rejects(az.decodeTarget({ kind: "pipeline", workflow: "ci.yml" }), /not implemented yet — built on the work machine/);
  await assert.rejects(az.discoverTargets("repo"), /not implemented yet — built on the work machine/);
});
