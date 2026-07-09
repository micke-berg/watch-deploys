# watch-deploys — a local, read-only deploy + pipeline dashboard

[![CI](https://github.com/micke-berg/watch-deploys/actions/workflows/ci.yml/badge.svg)](https://github.com/micke-berg/watch-deploys/actions/workflows/ci.yml)

The post-merge half of the delivery loop, on your own machine. A merge is not the finish
line — the pipeline still has to go green, the build still has to reach an environment, and
prod can quietly fall behind. watch-deploys shows one glanceable board that answers *did it
ship, and is anything behind*, and fires a desktop (and optional phone) notification only
when something actually needs you.

It is **read-only** against your CI/CD host: it never triggers, re-runs, approves, or rolls
back anything. The only thing it writes is a small local state file.

It is the sibling of [watch-pr](https://github.com/micke-berg/watch-pr) — same shape, same
provider seam, same zero-dependency, single-port, always-on model — for the stage *after* a
PR merges. Zero runtime dependencies: pure Node plus your host's own CLI (`gh` / `az`).

There is **no AI anywhere in this tool**. It is a deterministic watcher.

## What you get

- A live dashboard at `http://localhost:7879` — **one card per target**, sorted
  most-urgent-first, with a "needs you" counter over the top.
- **Three kinds of card:**

  | kind | the question it answers |
  | --- | --- |
  | `pipeline` | did the latest run of this workflow, on this branch, go green? |
  | `environment` | what is deployed here, did the last deploy succeed, and is it behind the default branch? |
  | `release` | what is the latest published release, and how far is the default branch ahead of it? |

- **Ambient awareness** — the favicon carries a red dot whenever something needs you (and the
  tab title shows the count, `watch-deploys (N)`), so a pinned tab tells you at a glance
  without switching to it. It clears back to plain 🚀 when nothing does.
- **Light and dark theme** — follows your OS by default, with a ☀/☾ toggle in the header that
  remembers your choice (per browser). Both themes share the watch-* family design language.
- A **resident poller** that keeps the board fresh and fires notifications with no editor or
  agent running — faster while a run/deploy is in flight, slower when everything is settled,
  and zero host calls when nothing is being watched.
- **＋ Watch** — add any pipeline, environment, or release by hand; monitored just like the rest.

The single most-important status of each card drives the sort and the needs-you count:

```
DEPLOY FAILED  ›  PIPELINE RED  ›  BEHIND  ›  DEPLOYING / RUNNING / QUEUED  ›  CURRENT / PASSING  ›  NO DATA
└──────────────── needs you ────────────────┘
```

## Notifications — action-needed edges only

Quiet by default. Each notification is **edge-triggered** (fires once, on the transition) and
only for something you'd actually act on:

- **Pipeline red** — the tracked branch's latest run failed.
- **Deploy failed** — the latest deployment to an environment failed.
- **Behind** — an environment or release first crosses the drift threshold
  (`driftWarnCommits`, default 1) behind its base branch.

A recovery is not a notification. An already-red or already-behind target added to the board
does not re-announce its existing state — only future changes fire.

- **Desktop** is automatic and needs no setup (Windows toast, macOS notification, Linux
  `notify-send`). On macOS the *first* notification may trigger the system's own permission
  prompt — that's macOS, granted once.
- **Phone (optional)** via [ntfy](https://ntfy.sh): set `ntfyTopic` to a long private string
  and subscribe the ntfy app to it. Works identically on every OS (a plain HTTPS POST).

## How it works (the short version)

- **The OS is auto-detected** at runtime. The notifier picks Windows toast / macOS
  `osascript` / Linux `notify-send` by itself. `npm start` is the same everywhere.
- **The provider is one config line** (`"provider": "github" | "azure"`). The core, poller,
  dashboard, and notifications never learn which host they're talking to.
- **Auth lives in the host CLI**, not here: you run `gh auth login` (or `az login`) once.
  watch-deploys holds no tokens.

## Requirements

- **Node.js 18+**
- Your host's CLI, authenticated once:
  - **GitHub:** `gh` → `gh auth login`
  - **Azure DevOps:** `az` with the **azure-devops** extension → `az login`
    *(the Azure adapter is a documented stub in this build — see below)*

## Quickstart

The example below is **GitHub on macOS/Linux**. **Windows:** same, but launch with
`dashboard.cmd`. Needs [Node.js 18+](https://nodejs.org) and [`gh`](https://cli.github.com):

```sh
gh auth login                                     # once, if you haven't already
git clone https://github.com/micke-berg/watch-deploys
cd watch-deploys
cp config.example.json config.json                # then set defaultRepository + targets
npm start                                          # dashboard → http://localhost:7879
```

> Using an AI coding agent? This README is written to be read top-to-bottom by one — point it
> at the repo and the steps above are all it needs (you'll still run `gh auth login` yourself,
> since that's an interactive browser flow).

## Setup

1. Clone this repo anywhere. There are no dependencies to install — it runs on Node's
   standard library alone.
2. Copy `config.example.json` → `config.json`, set `defaultRepository`, and list the
   **targets** you want on the board:

   ```jsonc
   {
     "provider": "github",
     "defaultRepository": "your-org/your-repo",
     "targets": [
       { "kind": "pipeline", "workflow": "ci.yml", "branch": "main" },
       { "kind": "environment", "name": "production" },
       { "kind": "release" }
     ]
   }
   ```

   Or set `"autoDiscover": true` to watch every active workflow + every environment in
   `autoDiscoverRepository` (defaults to `defaultRepository`) automatically.

3. Start it:
   ```sh
   npm start           # = node server.js  (all OSes)
   node check.js       # or: print the current board to the terminal, once
   ```
   then open `http://localhost:7879` — or use `dashboard.cmd` (Windows) / `dashboard.sh`
   (macOS/Linux).

   **Pin it as an app** (optional): in Edge/Chrome, click **Install** in the address bar for a
   real app window with a live count badge on the icon; in Safari, **File → Add to Dock**. The
   always-on server keeps running in the background either way, so notifications still fire
   whether or not the window is open.

### Config keys

| key | what |
| --- | --- |
| `provider` | `"github"` or `"azure"` |
| `defaultRepository` | GitHub `owner/repo` (Azure: the repo name) used when a target omits one |
| `targets` | the watch list — one entry per card (see the shape above) |
| `autoDiscover` / `autoDiscoverRepository` | discover a repo's workflows + environments instead of listing them |
| `branch` | default branch to track pipelines on (empty = the repo's default branch) |
| `driftWarnCommits` | commits behind the base branch that count as "behind" (default 1) |
| `me` | your host identity (display only; GitHub resolves it from `gh` if empty) |
| `ntfyTopic` / `ntfyServer` | optional phone push (see Notifications) |
| `port` | dashboard/server port (default 7879; `WATCH_DEPLOYS_PORT` overrides) |
| `cadence` | `{ activeSeconds, steadySeconds }` poll cadence in/out of flight |
| `builtBy` / `builtByUrl` | footer attribution |

## Always-on (optional, one-time per OS)

Keep it running from every login. An empty watch list makes zero network calls, so it's
idle-cheap.

- **macOS:** copy `macos/com.watchdeploys.plist.example` to
  `~/Library/LaunchAgents/com.watchdeploys.plist`, fill in your `node` + repo paths, then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.watchdeploys.plist`. launchd
  does **not** load your shell env, so set `ghCliPath`/`azCliPath` to an absolute path in
  `config.json` (e.g. `which gh`) or the board sits empty, and point `node` at its real binary
  (`node -e "console.log(process.execPath)"`), not a version-manager shim.
- **Linux:** copy `linux/watch-deploys.service.example` to
  `~/.config/systemd/user/watch-deploys.service`, fill in your paths, then
  `systemctl --user enable --now watch-deploys.service` (same `PATH` caveat).

## Adding targets

- **Declaratively** — list them in `config.targets` (or turn on `autoDiscover`).
- **By hand** — the dashboard's **＋ Watch** control (pick pipeline / environment / release).
- **From automation** — `POST /watch` (the agentic seam, below).

## Fits an agentic workflow

The board is driven by a tiny local endpoint, so any automation that just merged/shipped
something can put it on the board instantly — a git hook, a CI step, or your coding agent:

```sh
# a pipeline on a branch:
curl -X POST "http://localhost:7879/watch?kind=pipeline&repo=$OWNER_REPO&workflow=deploy.yml&branch=main"
# an environment:
curl -X POST "http://localhost:7879/watch?kind=environment&repo=$OWNER_REPO&name=production"
```

The resident poller keeps it fresh from there. This is the only "write" the tool accepts, and
it writes to your **local** board, never to the host.

## The provider seam

Everything host-specific lives behind a small neutral contract — an adapter implements only:

```text
provider.me                       // your identity (display only)
provider.targetUrl(target)        // a stable web URL for the card
provider.decodeTarget(target)     // -> the neutral decoded snapshot (health, behindBy, sha, …)
provider.discoverTargets(repo)?   // optional -> [{kind, repository, …}] to auto-watch
```

The full spec — the exact snapshot shape and how the core reads it — is in
[`docs/provider-contract.md`](docs/provider-contract.md). Adding a host (GitLab, Bitbucket,
CircleCI, …) is one new file under `providers/`, nothing else.

- **`providers/github.js`** is fully working via `gh`: workflow runs, deployments, releases,
  and commit-compare drift.
- **`providers/azure.js`** is an honest stub. It documents the neutral contract, ships the
  real shell-safety validators and URL builder, and its data functions **error**
  `not implemented yet — built on the work machine` rather than fabricate data. It is
  finished on a machine that has `az` and a real Azure DevOps project.

## Safety

- **Read-only against your host** — it only ever reads run/deploy/release state. It never
  triggers, re-runs, approves, or rolls back anything. The `✕` button only prunes your local
  list.
- **Local only** — the server binds to `127.0.0.1`, rejects requests whose `Host` isn't a
  localhost name (blocks DNS-rebinding), and rejects cross-origin requests to its
  state-changing endpoints (blocks CSRF).
- **No secrets stored** — auth is delegated to `gh` / `az`. `config.json` and `state.json`
  are gitignored, and `config.json` is never served over HTTP.
- **Optional phone push leaves your machine** — if you set `ntfyTopic`, card titles are POSTed
  to your ntfy server. Leave it empty to keep everything local.

## Files

| file | role |
| --- | --- |
| `index.html` | the dashboard shell (PWA head, theme bootstrap, layout) |
| `app.css` | the watch-* family design tokens (both theme sets) + reset |
| `app.js` | all dashboard behaviour (render, sort, ＋ Watch, dismiss, theme, polling) |
| `check.js` | provider-agnostic poll + decode core, status derivation, notifications, seeding |
| `providers/github.js`, `providers/azure.js` | the host adapters (the only host-specific code) |
| `notify.js` / `notify.ps1` | cross-platform notifier (OS-detected) + the Windows toast helper |
| `server.js` | static server + resident poller + endpoints |
| `config.js` / `config.json` | settings (copy from `config.example.json`) |
| `state.json` | the watch list + per-card snapshots (created at runtime) |
| `manifest.webmanifest` / `icon.svg` | PWA install metadata + app icon |
| `dashboard.sh` / `dashboard.cmd` / `macos/…plist` / `linux/…service` | launchers |
| `docs/provider-contract.md` | the neutral contract every adapter implements |

Endpoints (all local): `GET /status`, `GET /config`, `POST /check`, `POST /watch`, `POST /dismiss`.

## Tests

```sh
npm test        # = node --test  (Node's built-in runner, no dependencies)
```

Covers the design-status derivation, the edge-triggered notification logic, the GitHub health
mappings, the Azure input validation + "never fake data" stub contract, and the server's
security guards. CI runs the suite on Windows, macOS, and Linux across Node 18 / 20 / 22.

## Credits

Built by [Micke Berg](https://mickeberg.com).

## License

MIT.
