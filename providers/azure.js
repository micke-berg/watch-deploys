// providers/azure.js — the Azure DevOps provider adapter for watch-deploys.
//
// ┌─ HONEST STUB ────────────────────────────────────────────────────────────────┐
// │ This adapter is NOT implemented in this build. It is finished on the Windows   │
// │ work machine, which has `az`, the org/project, and a real pipeline + release   │
// │ to read. decodeTarget/discoverTargets throw a clear "not implemented yet" —    │
// │ they never fabricate data. Everything a Windows session needs to finish it     │
// │ without touching any other file is here: the exact neutral contract to return  │
// │ (below and in docs/provider-contract.md), the shell-safety validators (real +  │
// │ unit-tested), and the URL builder (real). Implement the two throwing functions │
// │ against `az pipelines runs` / `az pipelines release` and you are done.         │
// └───────────────────────────────────────────────────────────────────────────────┘
//
// The neutral seam the core consumes (identical across providers):
//   me                    identity string (display only)
//   targetUrl(target)     a stable web URL for the card
//   decodeTarget(target)  -> the neutral decoded snapshot documented below
//   discoverTargets(repo) -> optional [{kind, repository, …}] to auto-watch
//
// decodeTarget(target) MUST return this exact shape (the core reads `health` + `behindBy`
// + `kind` and nothing host-specific). A "target" is one card; kind is
// "pipeline" | "environment" | "release":
//
//   {
//     kind,        // echo target.kind: "pipeline" | "environment" | "release"
//     name,        // display name (pipeline/definition name, environment name, or release tag)
//     health,      // "ok" | "failed" | "running" | "queued" | "none"  (the run/deploy state)
//     state,       // raw host token for change detection (e.g. "succeeded" | "failed" | "inProgress")
//     behindBy,    // integer >= 0 (commits behind the base branch), or null when N/A
//                  //   pipelines: null. environments/releases: the drift, else null if unknown.
//     base,        // the branch drift is measured against (usually the default branch)
//     title,       // latest run/deploy/release title (commit subject / release name)
//     ref,         // branch or tag
//     sha,         // commit (full), or ""      shortSha, // 7-char, or ""
//     actor,       // who triggered it, or ""
//     number,      // run/build number, or null
//     event,       // trigger token, or ""
//     createdAt,   // ISO start time            finishedAt, // ISO completion time, or ""
//     url,         // web URL to the specific run/deployment/release
//   }
//
// Mapping notes for the implementer (az -> neutral):
//   pipeline (az pipelines runs list --pipeline-ids <id> --branch <ref> --top 1):
//     result/status -> health:  succeeded->ok; failed/canceled->failed; inProgress->running;
//     notStarted->queued; else none.  behindBy: null.
//   environment / release (az pipelines release list, or the environments REST API):
//     the deployment's status -> health the same way; behindBy = commits the default branch
//     is ahead of the deployed commit (az repos / git rev-list, or the compare REST call).
//   The identity `me` is display-only here (deploys have no "your comments" concept).

const config = require("../config.js");

const ME = config.me;
const NOT_IMPLEMENTED =
  "Azure DevOps adapter not implemented yet — built on the work machine. " +
  "See providers/azure.js and docs/provider-contract.md for the neutral contract to fill in.";

// Azure DevOps web URL for a card. This is a pure string builder, so it is real (not a stub):
// it needs no `az` call and lets the dashboard link out the moment the adapter is finished.
function targetUrl(target) {
  const repo = target.repository || config.defaultRepository;
  const org = config.organization || "https://dev.azure.com/YOUR-ORG";
  const project = config.project || "YOUR-PROJECT";
  if (target.kind === "environment" || target.kind === "release")
    return `${org}/${project}/_release`;
  return `${org}/${project}/_build`;
}

// ── shell-safety validators (REAL + unit-tested) ────────────────────────────────
// The `az` CLI is a .cmd on Windows, so its args are interpolated into a command line.
// These are the trust boundary the implemented decodeTarget must call before shelling out —
// they stop shell-metacharacter injection from an untrusted target (e.g. a CSRF POST to
// /watch?repo=...). project/org come from local (trusted) config.
function assertSafeId(id) {
  if (!/^\d+$/.test(String(id))) throw new Error("id must be numeric");
}
function assertSafeName(name) {
  // pipeline / environment names: letters, digits, spaces, and . _ / - only.
  if (!/^[A-Za-z0-9._/ -]+$/.test(String(name))) throw new Error("invalid target name");
}
// Blacklist (not whitelist) so international names / apostrophes / emails still pass, while a
// stray quote or shell metachar can't break out of a quoted argument.
function assertSafeIdentity(who) {
  if (/["`$\\;&|<>%^!\r\n]/.test(String(who))) throw new Error("config.me contains characters unsafe for a shell argument");
}

// The two functions the Windows session implements. They THROW rather than fake data.
async function decodeTarget(target) {
  assertSafeName(target && (target.workflow || target.name || target.pipeline || ""));
  throw new Error(NOT_IMPLEMENTED);
}
async function discoverTargets(repo) {
  throw new Error(NOT_IMPLEMENTED);
}

module.exports = {
  me: ME, targetUrl, decodeTarget, discoverTargets,
  // exported for unit tests + the future implementation:
  assertSafeId, assertSafeName, assertSafeIdentity, NOT_IMPLEMENTED,
};
