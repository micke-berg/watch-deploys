# The provider contract

Everything host-specific in watch-deploys lives behind one small **neutral contract**. The
core (`check.js`), the dashboard, and the notifications never learn which host they are
talking to — they only ever see the decoded snapshot below. Adding a host (or finishing the
Azure DevOps adapter) is **one file under `providers/`, nothing else**.

This document is the spec. A session on the Windows work machine can implement
`providers/azure.js` from this page alone, without touching the core, the server, or the UI.

## A "target" is one card

Each card watches one **target**. There are three kinds:

| kind | what it watches | GitHub source |
| --- | --- | --- |
| `pipeline` | a workflow/pipeline's latest run on a branch | `gh run list --workflow … --branch …` |
| `environment` | the latest deployment to an environment + how far it has fallen behind | deployments API + commit compare |
| `release` | the latest published release + how far the default branch is ahead of it | releases API + commit compare |

A target spec (from `config.targets`, the `POST /watch` endpoint, or discovery) looks like:

```jsonc
{ "kind": "pipeline",    "repository": "owner/repo", "workflow": "ci.yml", "branch": "main" }
{ "kind": "environment", "repository": "owner/repo", "name": "production" }
{ "kind": "release",     "repository": "owner/repo" }
```

`repository` is optional on each target (it falls back to `defaultRepository`). `branch` is
optional on a pipeline (it falls back to `config.branch`, then the repo's default branch).

## What an adapter must implement

```text
provider.me                     // identity string (display only — deploys have no "your comments")
provider.targetUrl(target)      // a stable web URL for the card (fallback link)
provider.decodeTarget(target)   // async -> the neutral decoded snapshot (below)
provider.discoverTargets(repo)  // async, optional -> [{kind, repository, …}] to auto-watch
```

## The neutral decoded snapshot

`decodeTarget(target)` must resolve to **exactly** this shape. The core reads `kind`,
`health`, and `behindBy` to decide the status, the sort order, and the notifications; every
other field is presentation the dashboard renders.

```jsonc
{
  "kind":       "pipeline" | "environment" | "release",  // echo target.kind
  "name":       "CI",              // display name (workflow/pipeline name, env name, or release tag)
  "health":     "ok" | "failed" | "running" | "queued" | "none",  // the run/deploy state
  "state":      "success",         // raw host token, for change detection (e.g. "succeeded" | "failed")
  "behindBy":   0,                 // integer >= 0 (commits behind the base branch), or null when N/A
                                   //   pipelines: always null. environments/releases: the drift,
                                   //   or null if it couldn't be computed.
  "base":       "main",            // the branch drift is measured against (usually the default branch)
  "title":      "Merge pull request #24 …",  // latest run/deploy/release title (commit subject / name)
  "ref":        "main",            // branch or tag
  "sha":        "09cd50c…",        // full commit sha, or ""
  "shortSha":   "09cd50c",         // 7-char sha, or ""
  "actor":      "micke-berg",      // who triggered it, or ""
  "number":     45,                // run/build number, or null
  "event":      "push",            // trigger token, or ""
  "createdAt":  "2026-07-09T20:55:24Z",  // ISO start time
  "finishedAt": "2026-07-09T20:56:03Z",  // ISO completion time, or ""
  "url":        "https://…"        // web URL to the specific run/deployment/release
}
```

### `health` — the one field the core keys on

| health | meaning | how the core reads it |
| --- | --- | --- |
| `ok` | the run passed / the deploy succeeded / a release exists | healthy — then `behindBy` decides passing/current vs behind |
| `failed` | the run failed / the deploy failed | urgent (`pipeline_failed` / `deploy_failed`) + fires the failure notification |
| `running` | a run/deploy is in progress | in flight; polled on the fast cadence |
| `queued` | queued, not started | in flight |
| `none` | nothing to report yet (no runs / no deployments / no releases) | shown as an idle "no data" card |

### `behindBy` — drift

- **Pipelines** are on a branch; "behind" doesn't apply. Return `null`.
- **Environments / releases**: return how many commits the **base** branch (usually the
  default branch) is *ahead of* the deployed commit / release tag. `0` means up to date;
  `> 0` means behind. Return `null` if you can't compute it (the core treats null as "not
  behind", never guesses).

The **behind** threshold and all notification timing live in the core — the adapter just
reports the number. The core fires each notification **once, on the edge**: a failure fires
when `health` first becomes `failed`; a drift fires when `behindBy` first crosses
`driftWarnCommits`. Because seeding stores the current values, an already-red or already-
behind target added to the board never notifies for its existing state.

## The GitHub adapter, as the worked example

`providers/github.js` implements all of the above via `gh`:

- **pipeline** — `gh run list -R <repo> --workflow <wf> --branch <branch> --limit 1 --json …`;
  `status`+`conclusion` → `health` (see `runHealth`).
- **environment** — `gh api repos/<repo>/deployments?environment=<env>&per_page=1`, then
  `…/deployments/<id>/statuses?per_page=1`; `state` → `health` (see `deployHealth`).
  `behindBy` = `ahead_by` from `gh api repos/<repo>/compare/<deployedSha>...<defaultBranch>`.
- **release** — `gh api repos/<repo>/releases/latest`; `health` is `ok` when a release exists
  (its urgency is drift, not a run status). `behindBy` = commits on the default branch since
  the release tag.
- **discovery** — `gh workflow list` (active workflows → pipelines) + `gh api
  repos/<repo>/environments` (→ environment cards).

## Finishing the Azure DevOps adapter

`providers/azure.js` is an honest stub in this build: it documents this contract, ships the
real shell-safety validators (`assertSafeId` / `assertSafeName` / `assertSafeIdentity`) and a
working `targetUrl`, and its `decodeTarget` / `discoverTargets` **throw**
`not implemented yet — built on the work machine` rather than return fabricated data.

To finish it, implement those two functions against the Azure CLI (`az pipelines runs list`,
`az pipelines release list`, and `az repos` / the compare REST call for drift), mapping their
output to the snapshot above. Nothing else in the codebase needs to change — the core already
consumes the neutral shape, and `test/azure.test.js` already pins the validators and the
"never fake data" contract.
