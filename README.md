# watch-deploys — a local, read-only deploy + pipeline dashboard

[![CI](https://github.com/micke-berg/watch-deploys/actions/workflows/ci.yml/badge.svg)](https://github.com/micke-berg/watch-deploys/actions/workflows/ci.yml)

The post-merge half of the delivery loop, on your own machine. A merge is not the
finish line — the pipeline still has to go green, the build still has to reach an
environment, and prod can quietly fall behind. watch-deploys answers *did it ship, and
is anything behind* at a glance, and fires a desktop (and optional phone) notification
only when something actually needs you.

It is **read-only** against your host: it never triggers, re-runs, approves, or rolls
back anything. The only thing it writes is a small local state file.

It is the sibling of [watch-pr](https://github.com/micke-berg/watch-pr) — same shape,
same provider seam, same zero-dependency, single-port, always-on model — for the stage
*after* a PR merges.

> **Status:** built in the open. This repo is scaffolded first (license, CI, config), then
> the engine and the dashboard land as their own pull requests. See the
> [Actions tab](https://github.com/micke-berg/watch-deploys/actions) for the live build.

## License

MIT.
