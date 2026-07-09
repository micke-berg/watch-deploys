// providers/github.js — the GitHub provider adapter for watch-deploys.
//
// Owns everything host-specific: the `gh` CLI, and mapping GitHub Actions workflow runs,
// deployments, and releases into the neutral provider contract that the core (check.js)
// consumes. The core never learns it is talking to GitHub — it only sees the decoded
// snapshot below. Read-only against GitHub: the only writes in the whole system are to the
// local state file, and those live in core.
//
// Auth is owned by the CLI: run `gh auth login` once. No tokens in config.
// Repos are "owner/repo". Identity ("me") is the gh login, resolved once at load
// (config.me overrides, to avoid the subprocess).
//
// The neutral seam (see docs/provider-contract.md) is three functions:
//   me                    identity string (display only)
//   targetUrl(target)     a stable web URL for the card (fallback when a decode has no run URL)
//   decodeTarget(target)  the neutral decoded snapshot (health, behindBy, sha, actor, url, …)
//   discoverTargets(repo) optional: [{kind, repository, …}] to auto-watch a repo's pipelines/envs
//
// A "target" is one card. kind is "pipeline" | "environment" | "release":
//   pipeline    { kind, repository, workflow, branch? }   latest workflow run on a branch
//   environment { kind, repository, name }                latest deployment to an environment + drift
//   release     { kind, repository }                      latest published release + drift

const { execFile, execFileSync } = require("child_process");
const config = require("../config.js");

// gh must be found without a shell (so nothing needs quoting). On Windows execFile needs
// the .exe; elsewhere plain "gh". config.ghCliPath overrides both.
const GH = config.ghCliPath || (process.platform === "win32" ? "gh.exe" : "gh");

// Resolve identity once. Prefer config.me; else ask gh. Never throw at load time.
let ME = config.me || "";
if (!ME) {
  try { ME = execFileSync(GH, ["api", "user", "-q", ".login"], { windowsHide: true }).toString().trim(); }
  catch (e) { ME = ""; }
}

// Run gh and parse its stdout as JSON. Rejects with the CLI's stderr so a failure reads clearly.
function gh(args) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      try { resolve(JSON.parse(stdout || "null")); }
      catch (e) { reject(new Error("bad JSON from gh: " + e.message)); }
    });
  });
}

const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : "");
const wfFile = (pathOrName) => String(pathOrName || "").split("/").pop();
const enc = (s) => encodeURIComponent(String(s == null ? "" : s));

// ── neutral health mappings (pure — unit-tested without a network) ──────────────
// A workflow run's status+conclusion -> neutral health.
function runHealth(status, conclusion) {
  const s = (status || "").toLowerCase();
  if (s === "completed") {
    const c = (conclusion || "").toLowerCase();
    return c === "success" || c === "neutral" || c === "skipped" ? "ok" : "failed";
  }
  if (s === "in_progress") return "running";
  if (s === "queued" || s === "requested" || s === "waiting" || s === "pending") return "queued";
  return "none";
}
// A deployment status's state -> neutral health.
function deployHealth(state) {
  const s = (state || "").toLowerCase();
  if (s === "success") return "ok";
  if (s === "failure" || s === "error") return "failed";
  if (s === "in_progress") return "running";
  if (s === "queued" || s === "pending") return "queued";
  if (s === "inactive") return "ok"; // superseded by a newer deploy; drift covers "behind"
  return "none";
}

// A stable web URL for a card, independent of any specific run/deploy (the decode's own
// .url is the primary link; this is the fallback and the "open the target" destination).
function targetUrl(target) {
  const repo = target.repository || config.defaultRepository;
  if (target.kind === "environment") return `https://github.com/${repo}/deployments`;
  if (target.kind === "release") return `https://github.com/${repo}/releases`;
  const wf = target.workflow ? `/workflows/${wfFile(target.workflow)}` : "";
  return `https://github.com/${repo}/actions${wf}`;
}

// Resolve a repo's real default branch (drift is always measured against it). Cached per
// repo for the process; falls back to "main" if the lookup fails.
const defaultBranchCache = new Map();
async function repoDefaultBranch(repo) {
  if (defaultBranchCache.has(repo)) return defaultBranchCache.get(repo);
  let b = "main";
  try { const info = await gh(["api", "repos/" + repo]); if (info && info.default_branch) b = info.default_branch; }
  catch (e) { /* keep "main" */ }
  defaultBranchCache.set(repo, b);
  return b;
}

// How many commits `head` is ahead of `base` — i.e. how far `base` (a deployed sha / release
// tag) has fallen behind `head` (the default branch). Best-effort: returns null on any error
// so a missing/unknown compare never sinks a decode.
async function driftBehind(repo, base, head) {
  if (!base || !head) return null;
  try {
    const c = await gh(["api", `repos/${repo}/compare/${enc(base)}...${enc(head)}`]);
    return typeof (c && c.ahead_by) === "number" ? c.ahead_by : null;
  } catch (e) { return null; }
}

// ── the three decoders ──────────────────────────────────────────────────────────
async function decodePipeline(target) {
  const repo = target.repository || config.defaultRepository;
  const branch = target.branch || config.branch || (await repoDefaultBranch(repo));
  const rows = await gh([
    "run", "list", "-R", repo, "--workflow", String(target.workflow || ""), "--branch", branch, "--limit", "1",
    "--json", "databaseId,number,status,conclusion,headBranch,headSha,event,displayTitle,workflowName,createdAt,updatedAt,url",
  ]);
  const run = (rows || [])[0];
  if (!run) {
    return {
      kind: "pipeline", name: target.workflow || "pipeline", health: "none", state: "none",
      behindBy: null, base: branch, title: "no runs yet", ref: branch, sha: "", shortSha: "",
      actor: "", number: null, event: "", createdAt: "", finishedAt: "", url: targetUrl(target),
    };
  }
  return {
    kind: "pipeline",
    name: run.workflowName || target.workflow || "pipeline",
    health: runHealth(run.status, run.conclusion),
    state: (run.conclusion || run.status || "").toLowerCase(),
    behindBy: null, // a pipeline run is on a branch; "behind" doesn't apply
    base: branch,
    title: run.displayTitle || "",
    ref: run.headBranch || branch,
    sha: run.headSha || "",
    shortSha: shortSha(run.headSha),
    actor: "",
    number: run.number,
    event: run.event || "",
    createdAt: run.createdAt || "",
    finishedAt: (run.status || "").toLowerCase() === "completed" ? (run.updatedAt || "") : "",
    url: run.url || targetUrl(target),
  };
}

async function decodeEnvironment(target) {
  const repo = target.repository || config.defaultRepository;
  const name = target.name;
  const base = await repoDefaultBranch(repo);
  const deps = await gh(["api", `repos/${repo}/deployments?environment=${enc(name)}&per_page=1`]);
  const dep = (deps || [])[0];
  if (!dep) {
    return {
      kind: "environment", name, health: "none", state: "none", behindBy: null, base,
      title: "nothing deployed yet", ref: "", sha: "", shortSha: "", actor: "", number: null,
      event: "", createdAt: "", finishedAt: "", url: targetUrl(target),
    };
  }
  let st = null;
  try { st = ((await gh(["api", `repos/${repo}/deployments/${dep.id}/statuses?per_page=1`])) || [])[0]; }
  catch (e) { /* no statuses yet — treat as queued */ }
  const health = deployHealth(st && st.state);
  return {
    kind: "environment",
    name,
    health,
    state: ((st && st.state) || "none").toLowerCase(),
    behindBy: health === "ok" ? await driftBehind(repo, dep.sha, base) : null,
    base,
    title: dep.description || `deploy ${shortSha(dep.sha)}`,
    ref: dep.ref || "",
    sha: dep.sha || "",
    shortSha: shortSha(dep.sha),
    actor: (dep.creator && dep.creator.login) || "",
    number: null,
    event: dep.task || "",
    createdAt: dep.created_at || "",
    finishedAt: (st && st.created_at) || "",
    url: (st && st.target_url) || targetUrl(target),
  };
}

async function decodeRelease(target) {
  const repo = target.repository || config.defaultRepository;
  const base = await repoDefaultBranch(repo);
  let rel = null;
  try { rel = await gh(["api", `repos/${repo}/releases/latest`]); }
  catch (e) { rel = null; } // no published release (or releases disabled) -> health none
  if (!rel || !rel.tag_name) {
    return {
      kind: "release", name: "releases", health: "none", state: "none", behindBy: null, base,
      title: "no releases yet", ref: "", sha: "", shortSha: "", actor: "", number: null,
      event: "", createdAt: "", finishedAt: "", url: targetUrl(target),
    };
  }
  return {
    kind: "release",
    name: rel.tag_name,
    health: "ok", // a published release shipped; its urgency is drift, not a run status
    state: "released",
    behindBy: await driftBehind(repo, rel.tag_name, base), // commits on the default branch since the tag
    base,
    title: rel.name || rel.tag_name,
    ref: rel.tag_name,
    sha: rel.target_commitish || "",
    shortSha: shortSha(rel.target_commitish),
    actor: (rel.author && rel.author.login) || "",
    number: null,
    event: rel.prerelease ? "prerelease" : "release",
    createdAt: rel.published_at || rel.created_at || "",
    finishedAt: rel.published_at || "",
    url: rel.html_url || targetUrl(target),
  };
}

// Fresh read of one target from GitHub. Returns the neutral decoded snapshot.
async function decodeTarget(target) {
  if (target.kind === "environment") return decodeEnvironment(target);
  if (target.kind === "release") return decodeRelease(target);
  return decodePipeline(target); // default + "pipeline"
}

// Optional: discover a repo's watchable targets — every active workflow as a pipeline, and
// every configured environment. The core merges these with any explicit config.targets.
async function discoverTargets(repo) {
  const repository = repo || config.defaultRepository;
  const out = [];
  try {
    const wfs = await gh(["workflow", "list", "-R", repository, "--json", "name,path,state"]);
    for (const w of wfs || []) {
      if ((w.state || "").toLowerCase() === "active") out.push({ kind: "pipeline", repository, workflow: wfFile(w.path) || w.name });
    }
  } catch (e) { /* no workflows / not accessible — skip */ }
  try {
    const envs = await gh(["api", `repos/${repository}/environments`]);
    for (const e of (envs && envs.environments) || []) out.push({ kind: "environment", repository, name: e.name });
  } catch (e) { /* no environments — skip */ }
  return out;
}

module.exports = {
  me: ME, targetUrl, decodeTarget, discoverTargets,
  // exported for unit tests (pure, no network):
  runHealth, deployHealth,
};
