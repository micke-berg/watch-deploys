// config.js — machine/user-specific settings for the watch-deploys system, loaded by
// both check.js and server.js. Real values live in config.json (copy config.example.json
// → config.json and fill it in). Anything absent falls back to the DEFAULTS below, so a
// colleague only has to set the identity + the targets, not every knob.
const fs = require("fs");
const path = require("path");

// Defaults are generic and host-neutral — nothing organization-specific ships here.
// Real values live in config.json (copy config.example.json → config.json).
const DEFAULTS = {
  provider: "github",                                  // which host to talk to: "github" | "azure"
  // --- GitHub ---
  ghCliPath: "",                                       // path to gh CLI; empty = "gh" (or "gh.exe" on Windows) on PATH
  // --- Azure DevOps ---
  azCliPath: process.platform === "win32"              // path to the az CLI
    ? "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"
    : "az",
  organization: "",                                    // az default org, e.g. https://dev.azure.com/your-org
  project: "",                                         // az default project
  // --- shared ---
  defaultRepository: "",                               // used when a target carries no repository
                                                       //   github: "owner/repo"; azure: "repo"
  me: "",                                              // your identity (GitHub login / Azure display name); optional,
                                                       //   used only for display. GitHub resolves it from gh if empty.
  branch: "",                                          // default branch to track pipelines on (empty = the repo's
                                                       //   default branch, resolved per repo)
  targets: [],                                         // the declarative watch list — the pipelines/environments/
                                                       //   releases to watch. See config.example.json for the shape.
  autoDiscover: false,                                 // discover a repo's workflows + environments automatically,
                                                       //   instead of (or in addition to) listing them by hand
  autoDiscoverRepository: "",                          // repo to auto-discover (empty = defaultRepository)
  driftWarnCommits: 1,                                 // an environment/release this many commits behind its base
                                                       //   branch counts as "behind" (the warn edge). Min 1.
  ntfyTopic: "",                                       // optional ntfy.sh topic for a phone push (empty = no phone push)
  ntfyServer: "https://ntfy.sh",                       // ntfy server base URL (self-host or ntfy.sh)
  port: 7879,                                          // dashboard/server port (WATCH_DEPLOYS_PORT env overrides)
  cadence: { activeSeconds: 60, steadySeconds: 300 },  // poll cadence: faster while something is running/deploying,
                                                       //   slower when every target is settled (~60s floor; the
                                                       //   resident poller is pure Node, so freshness sets these)
  builtBy: "",                                         // footer attribution name (empty = hidden)
  builtByUrl: "",                                      // optional link for the attribution
};

let file = {};
try {
  file = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (e) {
  console.error("watch-deploys: config.json not found — using defaults. Copy config.example.json → config.json to customise.");
}

module.exports = Object.assign({}, DEFAULTS, file, {
  cadence: Object.assign({}, DEFAULTS.cadence, file.cadence),
});
