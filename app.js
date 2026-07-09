// ─────────────────────────────────────────────────────────────────────────────
// watch-deploys dashboard. One card per target (pipeline / environment / release),
// wired to the live feed: state.json (per-target `display` blocks written by check.js)
// + the server's /status, /config, /check, /watch and /dismiss endpoints. Renders sample
// data when no server is reachable, so this same file doubles as a self-contained preview.
//
// Colour lives entirely in CSS custom properties (see app.css): :root is the dark theme,
// [data-theme="light"] the light theme. Flat colours are var(--x); the status tones are raw
// "L C H" triplets consumed by col()/cola() below so they can carry per-call alpha. The
// pre-paint theme bootstrap is inline in index.html's <head>; theme selection + persistence
// is at the bottom of this script. There is NO AI anywhere in this app.
// ─────────────────────────────────────────────────────────────────────────────

// ── design tokens ────────────────────────────────────────────────────────────
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

// status tones -> colour. col()/cola() resolve against the active theme's raw "L C H"
// custom property, so the same call renders correctly in both themes.
const FILL = new Set(["crit", "warn", "go"]); // tones drawn as a solid chip vs an outline
const col = (t) => `oklch(var(--${t}))`;
const cola = (t, a) => `oklch(var(--${t}) / ${a})`;
function isLight() { return currentTheme() === "light"; }

// design status model — rank drives sort + "needs you"; tone drives colour. Mirrors the
// derivation in check.js (statusKey); the display block already carries the computed status,
// this is the fallback for sample data + a single source for the labels.
const statusMeta = {
  deploy_failed:   { rank: 1, label: "DEPLOY FAILED", tone: "crit"   },
  pipeline_failed: { rank: 2, label: "PIPELINE RED",  tone: "crit"   },
  behind:          { rank: 3, label: "BEHIND",        tone: "warn"   },
  deploying:       { rank: 4, label: "DEPLOYING",     tone: "active" },
  running:         { rank: 5, label: "RUNNING",       tone: "active" },
  queued:          { rank: 6, label: "QUEUED",        tone: "active" },
  current:         { rank: 7, label: "CURRENT",       tone: "go"     },
  passing:         { rank: 8, label: "PASSING",       tone: "go"     },
  idle:            { rank: 9, label: "NO DATA",       tone: "dim"    },
};
const NEEDS_YOU_MAX_RANK = 3; // deploy_failed / pipeline_failed / behind

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function agoSec(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}
function agoShort(iso) {
  const s = agoSec(iso);
  if (s == null) return "—";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function mmss(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

// Recompute the design status from the neutral fields (the display block already carries it;
// this is the fallback for sample data). Kept in lockstep with check.js's statusKey.
function statusKey(kind, health, behindBy) {
  const warn = CFG.driftWarnCommits || 1;
  if (health === "failed") return kind === "pipeline" ? "pipeline_failed" : "deploy_failed";
  if (health === "running") return kind === "pipeline" ? "running" : "deploying";
  if (health === "queued") return "queued";
  if (health === "none") return "idle";
  if (behindBy != null && behindBy >= warn) return "behind";
  return kind === "pipeline" ? "passing" : "current";
}

// per-kind wording so one card renderer serves pipelines, environments, and releases.
function healthColor(h) {
  return h === "failed" ? col("crit") : h === "running" || h === "queued" ? col("active") : h === "ok" ? "var(--green)" : "var(--t-mute)";
}
function healthGlyph(h) { return h === "failed" ? "✕" : h === "running" ? "↻" : h === "queued" ? "◴" : h === "ok" ? "✓" : "–"; }
function healthWord(kind, h) {
  if (h === "failed") return "failed";
  if (h === "running") return kind === "pipeline" ? "running" : "deploying";
  if (h === "queued") return "queued";
  if (h === "none") return "no data";
  return kind === "pipeline" ? "passed" : kind === "release" ? "released" : "deployed";
}
function healthSub(kind, h) {
  if (h === "failed") return kind === "pipeline" ? "run failed" : "deploy failed";
  if (h === "running") return "in progress";
  if (h === "queued") return "waiting to run";
  if (h === "none") return kind === "pipeline" ? "no runs yet" : kind === "release" ? "no releases yet" : "nothing deployed";
  return kind === "pipeline" ? "all checks green" : kind === "release" ? "published" : "deploy succeeded";
}
const verbFor = (kind) => (kind === "pipeline" ? "ran" : kind === "release" ? "released" : "deployed");
const kindLabel = (kind) => (kind === "environment" ? "ENV" : String(kind || "pipeline").toUpperCase());

// ── normalise a state.json entry -> the view model the card expects ───────────
function activeVM(e) {
  const d = e.display || {};
  const kind = d.kind || e.kind || "pipeline";
  return {
    key: e.key,
    kind,
    name: d.name || e.name || e.workflow || kind,
    repo: d.repository || e.repository || "",
    base: d.base || "",
    health: d.health || "none",
    behindBy: d.behindBy == null ? null : d.behindBy,
    status: d.status || statusKey(kind, d.health, d.behindBy),
    shortSha: d.shortSha || "",
    title: d.title || "",
    ref: d.ref || "",
    actor: d.actor || "",
    event: d.event || "",
    when: d.finishedAt || d.createdAt || d.updatedAt || "",
    url: d.url || "#",
    error: e.error || "",
  };
}

// ── sample data (fallback when no server / opened as a bare file) ─────────────
const hAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const SAMPLE = [
  { key: "x1", kind: "environment", name: "production", repo: "acme/web", base: "main", health: "failed", behindBy: null, status: "deploy_failed", shortSha: "a1b2c3d", title: "Roll out the redesigned checkout flow", ref: "main", actor: "a-ruiz", event: "deployment", when: hAgo(0.4), url: "#" },
  { key: "x2", kind: "pipeline", name: "Deploy", repo: "acme/web", base: "main", health: "failed", behindBy: null, status: "pipeline_failed", shortSha: "e4f5a6b", title: "Bump the runtime image to 24.3.1", ref: "main", actor: "", event: "push", when: hAgo(1.2), url: "#" },
  { key: "x3", kind: "environment", name: "staging", repo: "acme/api", base: "main", health: "ok", behindBy: 6, status: "behind", shortSha: "c7d8e9f", title: "Deploy c7d8e9f", ref: "main", actor: "k-osei", event: "deployment", when: hAgo(19), url: "#" },
  { key: "x4", kind: "release", name: "v2.4.0", repo: "acme/cli", base: "main", health: "ok", behindBy: 18, status: "behind", shortSha: "b0c1d2e", title: "v2.4.0 — retry budgets + backoff", ref: "v2.4.0", actor: "m-devi", event: "release", when: hAgo(72), url: "#" },
  { key: "x5", kind: "environment", name: "canary", repo: "acme/web", base: "main", health: "running", behindBy: null, status: "deploying", shortSha: "f3a4b5c", title: "Deploy f3a4b5c", ref: "main", actor: "j-park", event: "deployment", when: hAgo(0.05), url: "#" },
  { key: "x6", kind: "pipeline", name: "CI", repo: "acme/api", base: "main", health: "running", behindBy: null, status: "running", shortSha: "d6e7f8a", title: "Add a cache warmup step to search", ref: "main", actor: "", event: "push", when: hAgo(0.1), url: "#" },
  { key: "x7", kind: "environment", name: "production", repo: "acme/api", base: "main", health: "ok", behindBy: 0, status: "current", shortSha: "a9b0c1d", title: "Deploy a9b0c1d", ref: "main", actor: "a-ruiz", event: "deployment", when: hAgo(5), url: "#" },
  { key: "x8", kind: "pipeline", name: "CI", repo: "acme/web", base: "main", health: "ok", behindBy: null, status: "passing", shortSha: "e2f3a4b", title: "Tidy the telemetry exporter", ref: "main", actor: "", event: "push", when: hAgo(2), url: "#" },
];

// ── runtime state ────────────────────────────────────────────────────────────
let latest = null;      // parsed state.json, or "error"
let everLoaded = false;  // have we ever successfully read real state?
let pollAlive = null;    // /status payload, or null
let checking = false;    // /check request in flight
// presentation config (overridden by the server's /config; defaults keep the standalone file
// looking right). Attribution + drift threshold live here so nothing is hardcoded.
let CFG = { builtBy: "Micke Berg", builtByUrl: "https://mickeberg.com", provider: "github", defaultRepository: "", driftWarnCommits: 1 };

// ── card rendering ───────────────────────────────────────────────────────────
function cardHtml(t) {
  const meta = statusMeta[t.status] || statusMeta.idle;
  const tone = meta.tone;
  const fill = FILL.has(tone);
  const c = col(tone);
  const light = isLight();
  const dim = t.status === "idle";

  const chipCommon = `flex-shrink:0;font-family:${MONO};font-size:11.5px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:999px;padding:8px 14px;white-space:nowrap;`;
  const chipStyle = fill
    ? chipCommon + `background:${c};color:var(--chip-text);`
        + (tone === "crit"
            ? `box-shadow:0 0 22px ${cola("crit", light ? 0.35 : 0.5)};`
            : (light ? `box-shadow:0 6px 16px -6px ${cola(tone, 0.5)};` : ""))
    : chipCommon + `background:${cola(tone, light ? 0.10 : 0.12)};color:${c};border:1px solid ${cola(tone, 0.4)};`;

  const accentColor = dim ? "var(--t-mute)" : c;
  const accentStyle = `width:5px;align-self:stretch;border-radius:6px;background:${accentColor};flex-shrink:0;`
    + (tone === "crit" ? `box-shadow:0 0 20px ${cola("crit", 0.6)};` : (fill ? `box-shadow:0 0 12px ${cola(tone, light ? 0.45 : 0.35)};` : ""));

  const cardStyle = `display:flex;gap:18px;padding:18px 20px;border-radius:16px;box-sizing:border-box;background:var(--panel);border:1px solid ${fill ? cola(tone, light ? 0.28 : 0.34) : "var(--border)"};box-shadow:var(--card-shadow);opacity:${dim ? 0.72 : 1};`;

  const valBase = `font-family:${MONO};font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;`;

  // metric 1 — state (raw run/deploy health; complements the status chip)
  const stColor = healthColor(t.health);
  const stGlyph = healthGlyph(t.health);
  const stSpin = t.health === "running" ? "display:inline-block;animation:spin 1.1s linear infinite;" : "display:inline-block;";

  // metric 4 — drift (env/release) or branch (pipeline)
  let m4label, m4val, m4color, m4sub;
  if (t.kind === "pipeline") {
    m4label = "Branch"; m4val = t.base || t.ref || "—"; m4color = "var(--t-strong)"; m4sub = t.event || "tracked";
  } else {
    m4label = "Drift";
    if (t.behindBy == null) { m4val = "—"; m4color = "var(--t-mute)"; m4sub = "unknown"; }
    else if (t.behindBy === 0) { m4val = "up to date"; m4color = "var(--green)"; m4sub = "vs " + (t.base || "base"); }
    else { m4val = t.behindBy + " behind"; m4color = col("warn"); m4sub = "vs " + (t.base || "base"); }
  }

  const commitVal = t.shortSha || "—";
  const commitSub = t.actor ? "by " + esc(t.actor) : (t.event ? esc(t.event) : "—");
  const updatedVal = t.when ? agoShort(t.when) + " ago" : "—";

  const errorRow = t.error
    ? `<div style="border-top:1px solid var(--divider); padding-top:11px; margin-top:2px; font-family:${MONO}; font-size:11px; color:${col("crit")}; white-space:pre-wrap; word-break:break-word;">couldn't read: ${esc(t.error)}</div>`
    : "";

  return `
  <article style="${cardStyle}">
    <div style="${accentStyle}"></div>
    <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:15px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
        <div style="min-width:0; flex:1;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
            <span style="font-family:${MONO}; font-size:9.5px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color: var(--t-dim); border:1px solid var(--border); border-radius:5px; padding:2px 7px;">${kindLabel(t.kind)}</span>
            <span style="font-family:${MONO}; font-size:12px; color: var(--t-mute); letter-spacing:0.04em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(t.repo)}</span>
          </div>
          <a class="title" href="${esc(t.url)}" target="_blank" rel="noopener" style="display:inline-block; font-size: clamp(16px,1.5vw,19px); font-weight:600; line-height:1.3; color: var(--title); text-wrap:pretty;">${esc(t.name)}</a>
          <div style="margin-top:5px; font-size:12.5px; color: var(--t-soft); line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(t.title || "—")}</div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="${chipStyle}">${meta.label}</span>
          <button onclick="dismiss('${esc(t.key)}')" title="Stop watching this" aria-label="Stop watching ${esc(t.name)}" style="flex-shrink:0; width:29px; height:29px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:transparent; border:1px solid var(--border); color: var(--t-dim); cursor:pointer; font-size:12px;">✕</button>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(128px,1fr)); gap:16px; border-top:1px solid var(--divider); padding-top:15px;">
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">State</span>
          <span style="${valBase} color:${stColor};"><span style="${stSpin}">${stGlyph}</span>${healthWord(t.kind, t.health)}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint);">${healthSub(t.kind, t.health)}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">Commit</span>
          <span style="${valBase} color: var(--code-text);">${esc(commitVal)}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${commitSub}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">Updated</span>
          <span style="${valBase} color: var(--t-strong);">${updatedVal}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint);">${verbFor(t.kind)}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">${m4label}</span>
          <span style="${valBase} color:${m4color};">${esc(String(m4val))}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(m4sub)}</span>
        </div>
      </div>
      ${errorRow}
    </div>
  </article>`;
}

// ── hero band ────────────────────────────────────────────────────────────────
function heroHtml(cards) {
  const rankOf = (c) => (statusMeta[c.status] || statusMeta.idle).rank;
  const toneOf = (c) => (statusMeta[c.status] || statusMeta.idle).tone;
  const needYou = cards.filter((c) => rankOf(c) <= NEEDS_YOU_MAX_RANK).length;
  const anyCrit = cards.some((c) => toneOf(c) === "crit");
  const heroTone = needYou > 0 ? (anyCrit ? "crit" : "warn") : "go";
  const cnt = (st) => cards.filter((c) => c.status === st).length;
  const light = isLight();

  const segs = [];
  if (cnt("deploy_failed")) segs.push(cnt("deploy_failed") + " DEPLOY FAILED");
  if (cnt("pipeline_failed")) segs.push(cnt("pipeline_failed") + " PIPELINE RED");
  if (cnt("behind")) segs.push(cnt("behind") + " BEHIND");
  const breakdown = segs.join("     ·     ");

  const bandStyle = `display:flex; align-items:center; justify-content:space-between; gap:24px; flex-wrap:wrap; border-radius:20px; padding: clamp(22px,3vw,34px); background:${cola(heroTone, light ? 0.10 : 0.07)}; border:1px solid ${cola(heroTone, light ? 0.30 : 0.24)};`
    + (light ? `box-shadow:0 1px 2px oklch(0.45 0.03 262 / 0.05), 0 22px 48px -20px ${cola(heroTone, 0.35)};` : "");

  const left = needYou > 0
    ? `<span style="color:${col(heroTone)}; font-size: clamp(64px,11vw,150px); font-weight:800; line-height:0.82; letter-spacing:-0.04em;">${needYou}</span>
       <div style="display:flex; flex-direction:column; gap:9px;">
         <span style="font-family:${MONO}; font-size: clamp(16px,2vw,22px); font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color: var(--title);">Need you</span>
         <span style="font-family:${MONO}; font-size:12px; letter-spacing:0.08em; color: var(--t-mute);">${breakdown}</span>
       </div>`
    : `<span style="color:${col("go")}; font-size: clamp(50px,8vw,104px); line-height:0.9;">✓</span>
       <div style="display:flex; flex-direction:column; gap:9px;">
         <span style="font-family:${MONO}; font-size: clamp(20px,3vw,30px); font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color: var(--title);">All clear</span>
         <span style="font-family:${MONO}; font-size:12px; letter-spacing:0.08em; color: var(--t-mute);">Nothing needs you right now</span>
       </div>`;

  const failing = cards.filter((c) => toneOf(c) === "crit").length;
  const behind = cnt("behind");
  const green = cards.filter((c) => c.status === "current" || c.status === "passing").length;
  const stat = (v, l) => `<div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;"><span style="font-family:${MONO}; font-size:26px; font-weight:700; color: var(--t-strong);">${v}</span><span style="font-family:${MONO}; font-size:9.5px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">${l}</span></div>`;

  return { needYou, html: `<section style="${bandStyle}">
      <div style="display:flex; align-items:center; gap:24px; min-width:0;">${left}</div>
      <div style="display:flex; gap:30px;">${stat(failing, "Failing")}${stat(behind, "Behind")}${stat(green, "Green")}</div>
    </section>` };
}

function emptyStateHtml() {
  return `<div style="font-family:${MONO}; font-size:13px; color: var(--t-mute); padding:26px 20px; border:1px dashed var(--border-soft); border-radius:14px; line-height:1.7;">
    No targets yet. Add one with <span style="color:var(--t-soft);">＋ Watch</span>, or list your pipelines and environments in <span style="color:var(--code-text);">config.json</span>.
  </div>`;
}

// ── top-level render ─────────────────────────────────────────────────────────
function render() {
  let cards, isSample;
  if (!latest || latest === "error") {
    cards = SAMPLE.slice();
    isSample = true;
  } else {
    cards = (latest.watching || []).map(activeVM);
    isSample = false;
  }
  cards.sort((a, b) =>
    ((statusMeta[a.status] || statusMeta.idle).rank - (statusMeta[b.status] || statusMeta.idle).rank)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );

  const hero = heroHtml(cards);
  document.getElementById("hero").innerHTML = hero.html;
  document.getElementById("cards").innerHTML = cards.length ? cards.map(cardHtml).join("") : emptyStateHtml();
  // The favicon carries the 🚀 / red-dot status, so the title stays plain text + count.
  document.title = hero.needYou ? `watch-deploys (${hero.needYou})` : "watch-deploys";
  setFavicon(hero.needYou > 0);
  setAppBadge(hero.needYou);

  updateMeta(isSample);
}

// App-icon badge for when watch-deploys is INSTALLED as an app. Shows the needs-you count on
// the icon and clears at zero. A no-op in a normal tab and where unsupported, so it never errors.
function setAppBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge && navigator.setAppBadge(n).catch(() => {});
    else navigator.clearAppBadge && navigator.clearAppBadge().catch(() => {});
  } catch (e) { /* Badging API unsupported — fine */ }
}

// Ambient awareness: the favicon carries a red notification dot whenever something needs you,
// so a pinned tab tells you at a glance without switching to it (pairs with the tab-title
// count). Cleared back to plain 🚀 when nothing does. The dot's ring follows the theme so it
// reads on both a light and a dark tab strip.
function setFavicon(alert) {
  const link = document.querySelector("link[rel='icon']");
  if (!link) return;
  const stroke = isLight() ? "#eef0f4" : "#141117";
  const rocket = "<text y='.9em' font-size='90'>🚀</text>";
  const dot = alert ? "<circle cx='80' cy='22' r='22' fill='#ff453a' stroke='" + stroke + "' stroke-width='7'/>" : "";
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" + rocket + dot + "</svg>";
  const href = "data:image/svg+xml," + encodeURIComponent(svg);
  if (link.href !== href) link.href = href; // only touch the DOM when it actually changes
}

// header freshness, liveness dots, footer label + check button — cheap, runs every 1s
function setDot(id, alive) {
  const el = document.getElementById(id);
  if (!el) return;
  const size = id === "headDot" ? "9px" : "8px";
  el.style.cssText = `width:${size}; height:${size}; border-radius:50%; background:${alive ? col("go") : "var(--t-mute)"}; box-shadow:${alive ? `0 0 10px ${cola("go", 0.8)}` : "none"}; animation:${alive ? "blink 1.8s ease-in-out infinite" : "none"};`;
}
function updateMeta(isSample) {
  if (isSample === undefined) isSample = (!latest || latest === "error");
  const alive = !!(pollAlive && pollAlive.alive);
  setDot("headDot", alive && !isSample);
  setDot("footDot", alive && !isSample);

  // freshness
  const fresh = document.getElementById("freshText");
  if (checking) fresh.textContent = "checking…";
  else if (isSample) fresh.textContent = "sample data";
  else {
    let newest = "";
    (latest.watching || []).forEach((e) => {
      const u = (e.display && e.display.updatedAt) || e.lastTickAt;
      if (u && u > newest) newest = u;
    });
    fresh.textContent = newest ? "updated " + agoShort(newest) + " ago" : "—";
  }

  // footer label
  const foot = document.getElementById("footLabel");
  if (isSample) foot.textContent = "STATIC PREVIEW   ·   SAMPLE DATA";
  else if (alive) {
    if (pollAlive.active && pollAlive.nextPollAt) {
      const rem = Math.max(0, Math.floor((new Date(pollAlive.nextPollAt).getTime() - Date.now()) / 1000));
      foot.textContent = "LIVE   ·   NEXT POLL " + mmss(rem);
    } else if (pollAlive.nextPollAt) {
      const rem = Math.max(0, Math.floor((new Date(pollAlive.nextPollAt).getTime() - Date.now()) / 1000));
      foot.textContent = rem > 0 ? "LIVE   ·   NEXT POLL " + mmss(rem) : "LIVE   ·   IDLE";
    } else {
      foot.textContent = "LIVE   ·   IDLE";
    }
  } else {
    foot.textContent = "VIEWER ONLY   ·   START SERVER.JS FOR LIVE UPDATES";
  }

  // check button
  const btn = document.getElementById("checkBtn");
  const spin = checking ? "display:inline-block;animation:spin 0.9s linear infinite;" : "display:inline-block;";
  btn.innerHTML = `<span style="${spin}">↻</span>${checking ? "CHECKING" : "CHECK NOW"}`;
  btn.disabled = checking;

  // footer attribution (config-driven)
  const built = document.getElementById("footBuilt");
  if (built) {
    if (!CFG.builtBy) built.textContent = "";
    else if (CFG.builtByUrl) built.innerHTML = `<a href="${esc(CFG.builtByUrl)}" target="_blank" rel="noopener" style="color:inherit;">built by ${esc(CFG.builtBy)} ↗</a>`;
    else built.textContent = "built by " + CFG.builtBy;
  }
}

// ── actions ──────────────────────────────────────────────────────────────────
async function checkNow() {
  if (checking) return;
  checking = true;
  updateMeta();
  try {
    const res = await fetch("/check", { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (data && data.watching) { latest = data; everLoaded = true; }
  } catch (e) { /* ignore */ }
  checking = false;
  render();
}
async function dismiss(key) {
  try { await fetch("/dismiss?key=" + encodeURIComponent(key), { method: "POST", cache: "no-store" }); } catch (e) {}
  tick();
}

// "＋ Watch" — add a pipeline / environment / release to the board.
function toggleAdd(show) {
  const bar = document.getElementById("addBar");
  const on = show === undefined ? bar.style.display === "none" : show;
  bar.style.display = on ? "flex" : "none";
  document.getElementById("addErr").textContent = "";
  if (on) {
    document.getElementById("addRepo").placeholder = "owner/repo (default: " + (CFG.defaultRepository || "—") + ")";
    document.getElementById("addRepo").value = "";
    document.getElementById("addName").value = "";
    document.getElementById("addBranch").value = "";
    syncAddFields();
    document.getElementById("addName").focus();
  }
}
// Swap the name/branch fields to match the chosen kind (pipeline needs a workflow + optional
// branch; environment needs a name; release needs nothing more).
function syncAddFields() {
  const kind = document.getElementById("addKind").value;
  const name = document.getElementById("addName");
  const branch = document.getElementById("addBranch");
  if (kind === "pipeline") {
    name.style.display = ""; name.placeholder = "workflow (e.g. ci.yml)";
    branch.style.display = "";
  } else if (kind === "environment") {
    name.style.display = ""; name.placeholder = "environment (e.g. production)";
    branch.style.display = "none";
  } else { // release
    name.style.display = "none";
    branch.style.display = "none";
  }
}
async function submitAdd() {
  const kind = document.getElementById("addKind").value;
  const repo = document.getElementById("addRepo").value.trim();
  const name = document.getElementById("addName").value.trim();
  const branch = document.getElementById("addBranch").value.trim();
  const err = document.getElementById("addErr");
  if (kind === "pipeline" && !name) { err.style.color = col("crit"); err.textContent = "enter a workflow (file name or name)"; return; }
  if (kind === "environment" && !name) { err.style.color = col("crit"); err.textContent = "enter an environment name"; return; }
  if (!repo && !CFG.defaultRepository) { err.style.color = col("crit"); err.textContent = "enter owner/repo"; return; }

  const params = new URLSearchParams({ kind });
  if (repo) params.set("repo", repo);
  if (kind === "pipeline") { params.set("workflow", name); if (branch) params.set("branch", branch); }
  if (kind === "environment") { params.set("name", name); }

  err.style.color = "var(--t-mute)"; err.textContent = "adding…";
  try {
    const res = await fetch("/watch?" + params.toString(), { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (data && data.ok) { toggleAdd(false); tick(); }
    else { err.style.color = col("crit"); err.textContent = (data && data.error) || ("HTTP " + res.status); }
  } catch (e) {
    err.style.color = col("crit"); err.textContent = "request failed — is the server running?";
  }
}

// ── theme (light / dark) ─────────────────────────────────────────────────────
// Selection precedence: an explicit stored choice wins; otherwise follow the OS. The toggle
// pins a choice to localStorage; while unpinned we track OS changes live. The flat palette is
// pure CSS (see app.css); JS only sets <html data-theme>, keeps the theme-color meta + favicon
// in sync, and re-renders so the theme-dependent shadows recompute.
const THEME_KEY = "watchdeploys-theme";
const mqLight = window.matchMedia("(prefers-color-scheme: light)");
function storedTheme() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : null; } catch (e) { return null; }
}
function currentTheme() { return storedTheme() || (mqLight.matches ? "light" : "dark"); }
function applyTheme() {
  const t = currentTheme();
  document.documentElement.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#f1f1f4" : "#131118");
  syncThemeBtn(t);
  render(); // recompute theme-dependent shadows/alpha + favicon
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme();
}
function syncThemeBtn(t) {
  const b = document.getElementById("themeBtn");
  if (!b) return;
  const light = (t || currentTheme()) === "light";
  const label = light ? "Switch to dark mode" : "Switch to light mode";
  b.textContent = light ? "☾" : "☀";
  b.title = label;
  b.setAttribute("aria-label", label);
}
mqLight.addEventListener("change", () => { if (!storedTheme()) applyTheme(); });

// ── polling loops ────────────────────────────────────────────────────────────
async function tick() {
  try {
    const res = await fetch("state.json?_=" + Date.now(), { cache: "no-store" });
    if (res.ok) { latest = await res.json(); everLoaded = true; }
    else if (!everLoaded) latest = "error";
  } catch (e) {
    if (!everLoaded) latest = "error";
  }
  render();
}
async function pollStatusTick() {
  try {
    const res = await fetch("/status?_=" + Date.now(), { cache: "no-store" });
    pollAlive = res.ok ? await res.json() : null;
  } catch (e) {
    pollAlive = null;
  }
  updateMeta();
}
async function loadConfig() {
  try {
    const res = await fetch("/config?_=" + Date.now(), { cache: "no-store" });
    if (res.ok) CFG = Object.assign(CFG, await res.json());
  } catch (e) { /* keep defaults */ }
  render();
}

document.getElementById("checkBtn").addEventListener("click", checkNow);
document.getElementById("themeBtn").addEventListener("click", toggleTheme);
document.getElementById("addBtn").addEventListener("click", () => toggleAdd(true));
document.getElementById("addName").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });
document.getElementById("addRepo").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });

applyTheme();  // set data-theme + meta/favicon/toggle, then first render
loadConfig();
tick();
pollStatusTick();
setInterval(tick, 3000);              // re-fetch state.json
setInterval(pollStatusTick, 5000);    // re-check the resident poller
setInterval(() => updateMeta(), 1000); // tick freshness + poll countdown
