import { TEAM_NAME } from "./config.js";
import { createStore, LIVE, newId } from "./store.js";
import { computeStats, validateMatch, winRate, pick, RESULTS, emptyRec } from "./stats.js";
import { PROXY_READY, normTag, validTag, fetchPlayer, fetchBattles, fetchLadder, forget } from "./bsapi.js";
import { readBattles, toSessions, aggregate, extreme, pretty } from "./bsstats.js";

// ---------------- state ----------------
const saved = (() => { try { return JSON.parse(localStorage.getItem("btt-ui")) || {}; } catch { return {}; } })();
const state = {
  lists: undefined,            // undefined = loading, null = not set up yet
  matches: [],
  user: undefined,             // undefined = loading, null = signed out
  readError: "",
  section: "tracker",          // which part of the site; tabs below are scoped to it
  ladder: null,                // { loading, error, season, total, updated, players, tiers }
  ladderShown: 100,
  tab: "dashboard",
  sub: { team: "summary", enemy: "summary" },
  filter: { from: saved.from || "", to: saved.to || "", minGames: saved.minGames ?? 5 },
  onlyPlayed: saved.onlyPlayed ?? true,
  sort: {},
  search: "",
  limit: 50,
  rowLimit: 300,
  form: null,
  editing: null,
  players: [],                 // saved player tags, shared by the team
  profile: null,               // { tag, loading, error, player, battles }
  tagInput: "",
  pSub: "overview",
};
const persistUi = () => {
  try {
    localStorage.setItem("btt-ui", JSON.stringify({ ...state.filter, onlyPlayed: state.onlyPlayed }));
  } catch { /* ignore */ }
};

let store;
const $ = sel => document.querySelector(sel);
const main = () => $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, dp = 1) => (x == null ? "" : (x * 100).toFixed(dp) + "%");
const canEdit = () => state.user && (state.user.role === "owner" || state.user.role === "member");
const isOwner = () => state.user && state.user.role === "owner";
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// Top-level sections. Add a new one here plus its tabs, and the nav picks it up.
const SECTIONS = [["tracker", "Match tracker"], ["players", "Player lookup"], ["ladder", "Ranked ladder"]];
const SECTION_TABS = {
  tracker: [["dashboard", "Dashboard"], ["log", "Log match"], ["matches", "Matches"],
    ["team", "Team"], ["enemy", "Enemy"], ["lists", "Lists"]],
  players: [],   // the Players view carries its own subtabs
  ladder: [],
};

let names = { b: new Map(), map: new Map(), mode: new Map() };
function indexLists() {
  const L = state.lists;
  names = {
    b: new Map(L.brawlers.map(x => [x.id, x.name])),
    map: new Map(L.maps.map(x => [x.id, x.name])),
    mode: new Map(L.modes.map(x => [x.id, x.name])),
  };
}
const bName = id => names.b.get(id) || "?";
const byName = (a, b) => a.name.localeCompare(b.name);

// heat colour for a win rate: red → yellow → green
function heat(wr) {
  if (wr == null) return "";
  const hue = Math.round(wr * 120);
  return `style="background:hsl(${hue} 72% 84%)"`;
}

// ---------------- toast ----------------
let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), bad ? 6000 : 2600);
}
async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message || String(e), true); }
}

// ---------------- top bar ----------------
function renderTop() {
  $("#team-name").textContent = TEAM_NAME;
  document.title = `${TEAM_NAME} · Brawl Stars tracker`;
  const u = state.user;
  let auth = "";
  if (!LIVE) auth = `<span class="who">Demo mode</span>`;
  else if (u === undefined) auth = "";
  else if (!u) auth = `<button class="btn btn-gold" data-act="signin">Sign in with Google</button>`;
  else {
    const role = { owner: "Owner", member: "Teammate", viewer: "Viewer" }[u.role];
    auth = `<span class="who" title="${esc(u.email)}">${esc(u.name)} <em>${role}</em></span>
            <button class="btn btn-ghost" data-act="signout">Sign out</button>`;
  }
  $("#auth").innerHTML = auth;
  $("#demo-banner").hidden = LIVE;

  $("#sections").innerHTML = SECTIONS.map(([id, label]) =>
    `<button class="sect${state.section === id ? " on" : ""}" data-section="${id}">${label}</button>`).join("");
  const tabs = SECTION_TABS[state.section] || [];
  $("#tabs").hidden = !tabs.length;
  $("#tabs").innerHTML = tabs.map(([id, label]) =>
    `<button class="tab tab-${id}${state.tab === id ? " on" : ""}" data-tab="${id}">${
      id === "log" && state.editing ? "Edit match" : label}</button>`).join("");

  const f = state.filter;
  // The date filters only apply to the logged games, not to live API profiles.
  $(".controls-in").hidden = state.section !== "tracker";
  $("#f-from").value = f.from; $("#f-to").value = f.to; $("#f-min").value = f.minGames;
  $("#f-warn").textContent = f.from && f.to && f.from > f.to ? "Start date is after the end date, so no games match." : "";
}

// ---------------- generic sortable table ----------------
// cols: {id, label, get(row), fmt?(row) -> html, num?, heat?}
function table(key, cols, rows, opts = {}) {
  const s = state.sort[key] || opts.defaultSort || { col: cols[0].id, dir: 1 };
  const col = cols.find(c => c.id === s.col) || cols[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * s.dir;
  });
  const shown = sorted.slice(0, opts.limit || Infinity);
  const head = cols.map(c => {
    const arrow = c.id === col.id ? (s.dir === 1 ? " ▲" : " ▼") : "";
    return `<th class="${c.num ? "num" : ""}"><button data-sort="${key}:${c.id}">${esc(c.label)}${arrow}</button></th>`;
  }).join("");
  const body = shown.map(r => `<tr>${cols.map(c => {
    const v = c.get(r);
    const html = c.fmt ? c.fmt(r) : esc(v ?? "");
    return `<td class="${c.num ? "num" : ""}" ${c.heat ? heat(v) : ""}>${html}</td>`;
  }).join("")}</tr>`).join("");
  const more = shown.length < sorted.length
    ? `<button class="btn btn-ghost more" data-act="morerows">Show more (${sorted.length - shown.length} left)</button>` : "";
  if (!rows.length) return `<p class="empty">${opts.empty || "No games in this date range yet."}</p>`;
  return `<div class="scroll"><table class="tbl">${"<thead><tr>" + head + "</tr></thead>"}<tbody>${body}</tbody></table></div>${more}`;
}
const recCols = (get, heatOn = true) => [
  { id: "g", label: "Games", num: true, get: r => get(r).g },
  { id: "w", label: "Wins", num: true, get: r => get(r).w },
  { id: "l", label: "Losses", num: true, get: r => get(r).l },
  { id: "d", label: "Draws", num: true, get: r => get(r).d },
  { id: "wr", label: "Win rate", num: true, heat: heatOn, get: r => winRate(get(r)), fmt: r => pct(winRate(get(r))) },
];

// ---------------- match list ----------------
function chips(ids, side) {
  return ids.map(id => `<span class="chip ${side}">${esc(bName(id))}</span>`).join("");
}
function matchTable(list, withActions) {
  if (!list.length) return `<p class="empty">No games in this date range yet.</p>`;
  const rows = list.map(m => `<tr>
    <td>${esc(m.date)}</td>
    <td>${esc(names.mode.get(m.mode) || "?")}</td>
    <td>${esc(names.map.get(m.map) || "?")}</td>
    <td class="chips">${chips(m.blue, "blue")}</td>
    <td><span class="res res-${m.result}">${RESULTS[m.result]}</span></td>
    <td class="chips">${chips(m.red, "red")}</td>
    ${withActions ? `<td class="acts"><button class="link" data-act="edit" data-id="${esc(m.id)}">Edit</button>
      <button class="link danger" data-act="delete" data-id="${esc(m.id)}">Delete</button></td>` : ""}
  </tr>`).join("");
  return `<div class="scroll"><table class="tbl matches"><thead><tr><th>Date</th><th>Mode</th><th>Map</th>
    <th>Your team</th><th>Result</th><th>Enemies</th>${withActions ? "<th></th>" : ""}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------------- views ----------------
function viewDashboard(S) {
  const t = S.totals, wr = winRate(t);
  const L = state.lists, mg = Number(state.filter.minGames) || 0;
  const tile = (label, p, side, valueFn) => `<div class="tile ${side}">
      <div class="tile-label">${label}</div>
      <div class="tile-value">${p ? esc(p.b.name) : "—"}</div>
      <div class="tile-sub">${p ? valueFn(p) : "Not enough games yet"}</div></div>`;
  const gamesTxt = p => `${p.r.g} game${p.r.g === 1 ? "" : "s"}`;
  const wrTxt = p => `${pct(p.wr, 0)} win rate · ${gamesTxt(p)}`;
  return `
  <section class="record">
    <div class="rec-num win"><span>${t.w}</span><label>Wins</label></div>
    <div class="rec-num loss"><span>${t.l}</span><label>Losses</label></div>
    <div class="rec-num draw"><span>${t.d}</span><label>Draws</label></div>
    <div class="rec-wr"><span>${wr == null ? "—" : pct(wr)}</span><label>Win rate · ${t.g} game${t.g === 1 ? "" : "s"}</label></div>
  </section>
  <div class="tiles">
    ${tile("Your most played", pick(S.team, L, "most", mg), "blue", gamesTxt)}
    ${tile("Your best brawler", pick(S.team, L, "best", mg), "blue", wrTxt)}
    ${tile("Your worst brawler", pick(S.team, L, "worst", mg), "blue", wrTxt)}
    ${tile("Most faced enemy", pick(S.enemy, L, "most", mg), "red", gamesTxt)}
    ${tile("Toughest enemy", pick(S.enemy, L, "best", mg), "red", p => `Beats you ${pct(p.wr, 0)} of the time · ${gamesTxt(p)}`)}
    ${tile("Easiest enemy", pick(S.enemy, L, "worst", mg), "red", p => `Beats you ${pct(p.wr, 0)} of the time · ${gamesTxt(p)}`)}
  </div>
  <p class="hint">Best, worst, toughest and easiest only count brawlers with at least ${mg} game${mg === 1 ? "" : "s"} (change it in the bar above).</p>
  <h2>Latest games</h2>
  ${matchTable(S.filtered.slice(0, 10), false)}
  ${S.filtered.length > 10 ? `<button class="btn btn-ghost more" data-tab="matches">See all ${S.filtered.length} games</button>` : ""}`;
}

function emptyForm() {
  const L = state.lists;
  const mode = L.modes[0] ? L.modes[0].id : "";
  const map = (L.maps.find(m => m.mode === mode) || {}).id || "";
  return { date: today(), mode, map, blue: ["", "", ""], red: ["", "", ""], result: "" };
}

function viewLog() {
  if (!canEdit()) {
    return `<div class="notice"><h2>Sign in to log games</h2>
      <p>${!state.user ? "Sign in with the Google account your team owner added." :
        `${esc(state.user.email)} isn't on the team yet. Ask the owner to add this email on the Teammates page.`}</p>
      ${!state.user ? `<button class="btn btn-gold" data-act="signin">Sign in with Google</button>` : ""}</div>`;
  }
  const L = state.lists;
  const f = state.form || (state.form = emptyForm());
  const maps = L.maps.filter(m => m.mode === f.mode).sort(byName);
  const chosen = [...f.blue, ...f.red];
  const brawlerSelect = (side, i) => {
    const cur = f[side][i];
    const opts = [...L.brawlers].sort(byName).filter(b => b.id === cur || !chosen.includes(b.id))
      .map(b => `<option value="${esc(b.id)}"${b.id === cur ? " selected" : ""}>${esc(b.name)}</option>`).join("");
    return `<select class="pick ${side}" data-field="${side}" data-i="${i}" aria-label="${side === "blue" ? "Your" : "Enemy"} brawler ${i + 1}">
      <option value="">${side === "blue" ? "Your" : "Enemy"} brawler ${i + 1}</option>${opts}</select>`;
  };
  return `<form class="logform" data-form="log" novalidate>
    <h2>${state.editing ? "Edit match" : "Log a match"}</h2>
    <div class="row3">
      <label>Date<input type="date" data-field="date" value="${esc(f.date)}" required></label>
      <label>Mode<select data-field="mode">${[...L.modes].sort(byName).map(m =>
        `<option value="${esc(m.id)}"${m.id === f.mode ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
      <label>Map<select data-field="map"><option value="">Pick a map</option>${maps.map(m =>
        `<option value="${esc(m.id)}"${m.id === f.map ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
    </div>
    ${maps.length ? "" : `<p class="hint">No maps are set to this mode yet. Add one on the Lists page.</p>`}
    <div class="teams">
      <fieldset class="team blue"><legend>Your team</legend>${[0, 1, 2].map(i => brawlerSelect("blue", i)).join("")}</fieldset>
      <fieldset class="result"><legend>Result</legend>
        ${["W", "L", "D"].map(r => `<button type="button" class="resbtn rb-${r}${f.result === r ? " on" : ""}" data-result="${r}" aria-pressed="${f.result === r}">${RESULTS[r]}</button>`).join("")}
      </fieldset>
      <fieldset class="team red"><legend>Enemies</legend>${[0, 1, 2].map(i => brawlerSelect("red", i)).join("")}</fieldset>
    </div>
    <div class="formacts">
      <button class="btn btn-gold" type="submit">${state.editing ? "Save changes" : "Save match"}</button>
      ${state.editing ? `<button class="btn btn-ghost" type="button" data-act="canceledit">Cancel</button>` :
        `<button class="btn btn-ghost" type="button" data-act="clearform">Clear</button>`}
    </div>
    <p class="hint">A brawler can only be picked once per match. Win / Loss / Draw is from your team's side.</p>
  </form>`;
}

function viewMatches(S) {
  const list = S.filtered.slice(0, state.limit);
  return `<div class="bar">
      <h2>${S.filtered.length} game${S.filtered.length === 1 ? "" : "s"} in this date range</h2>
      <div class="bar-acts">
        <button class="btn btn-ghost" data-act="export">Download as CSV</button>
        ${canEdit() ? `<label class="btn btn-ghost file">Import CSV<input type="file" accept=".csv,text/csv" data-act="import" hidden></label>` : ""}
      </div>
    </div>
    ${matchTable(list, canEdit())}
    ${S.filtered.length > list.length ? `<button class="btn btn-ghost more" data-act="moregames">Show 50 more</button>` : ""}
    ${canEdit() ? `<p class="hint">Import takes the Match Log from your spreadsheet: in Google Sheets, open the Match Log tab and use File ▸ Download ▸ Comma-separated values. Importing the same file twice adds the games twice.</p>` : ""}`;
}

function viewSide(side, S) {
  const st = S[side];
  const L = state.lists;
  const sub = state.sub[side];
  const enemy = side === "enemy";
  const subs = [["summary", "Summary"], ["maprates", "Map rates"], ["moderates", "Mode rates"], ["mapmatrix", "Map matrix"], ["modematrix", "Mode matrix"]];
  const played = b => st.brawler.has(b.id);
  const brawlers = L.brawlers.filter(b => !state.onlyPlayed || played(b));
  const rec = (m, k) => m.get(k) || emptyRec();
  const q = state.search.trim().toLowerCase();
  const note = enemy
    ? "Enemy win rate = how often that brawler beat your team. Draws are left out of win rates."
    : "Win rate = Wins ÷ (Wins + Losses). Draws are left out.";
  let body = "";
  const bCol = { id: "name", label: "Brawler", get: r => r.b.name, fmt: r => `<strong>${esc(r.b.name)}</strong>` };

  if (sub === "summary") {
    const modes = [...L.modes].sort(byName);
    const cols = [bCol, ...recCols(r => rec(st.brawler, r.b.id)),
      ...modes.map(m => ({ id: "m-" + m.id, label: m.name + " WR", num: true, heat: true,
        get: r => winRate(st.mode.get(r.b.id + "|" + m.id)), fmt: r => pct(winRate(st.mode.get(r.b.id + "|" + m.id))) }))];
    body = table(side + "-summary", cols, brawlers.map(b => ({ b })),
      { defaultSort: { col: "g", dir: -1 }, empty: "No games in this date range yet." });
  } else if (sub === "maprates" || sub === "moderates") {
    const isMap = sub === "maprates";
    const things = isMap ? L.maps : L.modes;
    const rows = [];
    for (const b of brawlers) {
      for (const t of things) {
        const r = (isMap ? st.map : st.mode).get(b.id + "|" + t.id);
        if (state.onlyPlayed && !r) continue;
        const modeName = isMap ? names.mode.get(t.mode) || "(no mode)" : "";
        if (q && !(b.name + " " + t.name + " " + modeName).toLowerCase().includes(q)) continue;
        rows.push({ b, t, r: r || emptyRec(), modeName });
      }
    }
    const cols = [bCol, { id: "t", label: isMap ? "Map" : "Mode", get: r => r.t.name },
      ...(isMap ? [{ id: "mo", label: "Mode", get: r => r.modeName }] : []),
      ...recCols(r => r.r)];
    body = `<input class="search" type="search" placeholder="Search brawler, map or mode" value="${esc(state.search)}" data-act="search" aria-label="Search">
      ${table(side + "-" + sub, cols, rows, { limit: state.rowLimit, defaultSort: { col: "g", dir: -1 } })}`;
  } else {
    const isMap = sub === "mapmatrix";
    const m = isMap ? st.map : st.mode;
    let things = [...(isMap ? L.maps : L.modes)].sort(byName);
    if (state.onlyPlayed) things = things.filter(t => brawlers.some(b => m.has(b.id + "|" + t.id)));
    const rows = [...brawlers].sort(byName);
    if (!rows.length || !things.length) body = `<p class="empty">No games in this date range yet.</p>`;
    else {
      body = `<div class="scroll matrix-wrap"><table class="matrix"><thead><tr><th class="corner">Brawler ↓ / ${isMap ? "Map" : "Mode"} →</th>
        ${things.map(t => `<th class="${isMap ? "rot" : ""}"><span>${esc(t.name)}</span></th>`).join("")}</tr></thead><tbody>
        ${rows.map(b => `<tr><th>${esc(b.name)}</th>${things.map(t => {
          const r = m.get(b.id + "|" + t.id), wr = winRate(r);
          const tip = r ? `${b.name} on ${t.name}: ${r.w}W ${r.l}L ${r.d}D` : "";
          return `<td ${heat(wr)} title="${esc(tip)}">${wr == null ? (r ? "–" : "") : Math.round(wr * 100) + "%"}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
  }
  return `<div class="side-head ${side}">
      <h2>${enemy ? "Enemy brawlers" : "Your team's brawlers"}</h2>
      <label class="toggle"><input type="checkbox" data-act="onlyplayed"${state.onlyPlayed ? " checked" : ""}> Only show brawlers${sub.endsWith("matrix") ? ", maps and modes" : ""} with games</label>
    </div>
    <div class="subtabs">${subs.map(([id, label]) => `<button class="subtab${sub === id ? " on" : ""}" data-sub="${side}:${id}">${label}</button>`).join("")}</div>
    <p class="hint">${note}</p>
    ${body}`;
}

function usage() {
  const u = { b: new Map(), map: new Map(), mode: new Map() };
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const m of state.matches) {
    [...m.blue, ...m.red].forEach(id => inc(u.b, id));
    inc(u.map, m.map); inc(u.mode, m.mode);
  }
  for (const mp of state.lists.maps) if (mp.mode) u.mode.set(mp.mode, (u.mode.get(mp.mode) || 0) + 0.001);
  return u;
}

function viewLists() {
  const L = state.lists, u = usage(), edit = canEdit();
  const modeOpts = sel => [...L.modes].sort(byName).map(m => `<option value="${esc(m.id)}"${m.id === sel ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  const item = (kind, x, extra = "") => {
    const used = Math.floor((u[kind === "brawlers" ? "b" : kind === "maps" ? "map" : "mode"].get(x.id)) || 0);
    const usedMaps = kind === "modes" ? L.maps.filter(m => m.mode === x.id).length : 0;
    const locked = used > 0 || usedMaps > 0;
    const why = used ? `Used in ${used} game${used === 1 ? "" : "s"}` : usedMaps ? `${usedMaps} map${usedMaps === 1 ? "" : "s"} use this mode` : "";
    return `<li><input value="${esc(x.name)}" data-rename="${kind}:${esc(x.id)}" aria-label="Name" ${edit ? "" : "disabled"}>
      ${extra}
      ${edit ? `<button class="link danger" data-act="remove" data-kind="${kind}" data-id="${esc(x.id)}" ${locked ? `disabled title="${why}"` : ""}>Delete</button>` : ""}</li>`;
  };
  const panel = (kind, title, items, addExtra = "") => `<section class="panel">
      <h3>${title} <span class="count">${items.length}</span></h3>
      ${edit ? `<form class="addrow" data-form="add-${kind}"><input name="name" placeholder="New ${title.toLowerCase().replace(/s$/, "")}" maxlength="40" required aria-label="New name">${addExtra}<button class="btn btn-gold" type="submit">Add</button></form>` : ""}
      <ul class="items">${items.join("")}</ul></section>`;
  return `<p class="hint">${edit ? "Rename anything by editing its name — every past game updates too. Items used in games can't be deleted." : "Sign in to change the lists."}</p>
    <div class="panels">
      ${panel("brawlers", "Brawlers", [...L.brawlers].sort(byName).map(b => item("brawlers", b)))}
      ${panel("maps", "Maps", [...L.maps].sort(byName).map(m => item("maps", m,
        `<select data-mapmode="${esc(m.id)}" aria-label="Mode for ${esc(m.name)}" ${edit ? "" : "disabled"}>${m.mode && L.modes.some(x => x.id === m.mode) ? "" : `<option value="">Pick mode</option>`}${modeOpts(m.mode)}</select>`)),
        `<select name="mode" aria-label="Mode" required>${modeOpts("")}</select>`)}
      ${panel("modes", "Modes", [...L.modes].sort(byName).map(m => item("modes", m)))}
    </div>`;
}

// ---------------- players: live profiles from the Brawl Stars API ----------------
let profileSeq = 0;
function loadProfile(raw) {
  const tag = normTag(raw);
  // Validate before touching any state, so a bad tag leaves the page exactly as it was.
  if (!validTag(tag)) { toast("That doesn't look like a player tag. They look like #Y2PLQQCGP.", true); return; }
  const seq = ++profileSeq;
  state.section = "players";
  state.profile = { tag, loading: true };
  state.pSub = "overview";
  render();
  (async () => {
    let next;
    try {
      const [player, items] = await Promise.all([fetchPlayer(tag), fetchBattles(tag)]);
      next = { tag, player, battles: readBattles(items, tag) };
    } catch (e) {
      next = { tag, error: e.message || String(e) };
    }
    if (seq !== profileSeq) return; // a newer lookup has started
    state.profile = next;
    render();
  })();
}

const num = n => (typeof n === "number" ? n.toLocaleString() : "—");
// The API shouts names and tiers ("SHELLY", "LEGENDARY III"). Anything already mixed-case
// is left alone, so map names like "G.G. Mortuary" survive untouched.
const title = s => {
  const t = String(s || "");
  if (/[a-z]/.test(t)) return t;
  return t.toLowerCase()
    .replace(/\b[a-z]/g, c => c.toUpperCase())
    .replace(/\b(I{1,3}|IV|VI{0,3}|IX|XI{0,3})\b/gi, m => m.toUpperCase());
};
const whenShort = at => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const trophyTxt = n => (n > 0 ? `+${n}` : n < 0 ? String(n) : "0");
const resCell = b => (b.result
  ? `<span class="res res-${b.result}">${RESULTS[b.result]}</span>`
  : b.rank != null ? `<span class="res res-D">#${b.rank}</span>` : "");

function savedTags() {
  const list = state.players || [];
  const cur = state.profile && state.profile.player;
  const saved = cur && list.some(p => normTag(p.tag) === normTag(cur.tag));
  const chips = list.map(p => `<span class="tagchip${state.profile && normTag(p.tag) === state.profile.tag ? " on" : ""}">
      <button class="link" data-act="loadtag" data-id="${esc(p.tag)}">${esc(p.label || p.tag)}</button>
      ${canEdit() ? `<button class="link danger" data-act="untag" data-id="${esc(p.tag)}" aria-label="Remove ${esc(p.label || p.tag)}">×</button>` : ""}
    </span>`).join("");
  const add = cur && canEdit() && !saved
    ? `<button class="btn btn-ghost" data-act="savetag">Save ${esc(cur.name || cur.tag)} to the team</button>` : "";
  if (!chips && !add) return "";
  return `<div class="tagchips">${chips}${add}</div>`;
}

function battleTable(key, battles, opts = {}) {
  const cols = [
    { id: "at", label: "When", get: b => b.at, fmt: b => esc(whenShort(b.at)) },
    { id: "kind", label: "Type", get: b => (b.ranked ? "Ranked" : pretty(b.type)), fmt: b =>
      `<span class="chip ${b.ranked ? "blue" : ""}">${esc(b.ranked ? (b.type === "teamranked" ? "Team Ranked" : "Solo Ranked") : pretty(b.type) || "—")}</span>` },
    { id: "mode", label: "Mode", get: b => b.mode },
    { id: "map", label: "Map", get: b => b.map },
    { id: "brawler", label: "Brawler", get: b => b.brawler, fmt: b =>
      `${esc(title(b.brawler)) || "—"}${b.starPlayer ? ' <span class="star" title="Star player">★</span>' : ""}` },
    { id: "res", label: "Result", get: b => ({ W: 2, D: 1, L: 0 }[b.result] ?? -1), fmt: resCell },
    { id: "tr", label: "Trophies", num: true, get: b => b.trophyChange, fmt: b => (b.trophyChange == null ? "" : trophyTxt(b.trophyChange)) },
  ];
  // Ranked games don't move trophies, so drop that column when every game here is ranked.
  const shown = battles.some(b => b.trophyChange != null) ? cols : cols.filter(c => c.id !== "tr");
  return table(key, shown, battles, { defaultSort: { col: "at", dir: -1 }, empty: "No games here.", ...opts });
}

function rankTile(label, name, elo, side) {
  return `<div class="tile ${side}">
      <div class="tile-label">${label}</div>
      <div class="tile-value">${name ? esc(title(name)) : "Unranked"}</div>
      <div class="tile-sub">${elo ? `${num(elo)} Elo` : "No ranked games yet"}</div></div>`;
}

function recTable(key, map, label, empty) {
  const rows = [...map.values()];
  const cols = [{ id: "name", label, get: r => r.name, fmt: r => `<strong>${esc(title(r.name))}</strong>` }, ...recCols(r => r.rec)];
  return table(key, cols, rows, { defaultSort: { col: "g", dir: -1 }, empty });
}

function viewPlayerOverview(p) {
  const pl = p.player;
  const all = aggregate(p.battles);
  const wr = winRate(all.rec);
  const tile = (label, value, sub = "", side = "blue") => `<div class="tile ${side}">
      <div class="tile-label">${label}</div><div class="tile-value">${value}</div>
      ${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
  return `<div class="tiles">
      ${tile("Ranked", pl.rankedRankName ? esc(title(pl.rankedRankName)) : "Unranked",
        pl.rankedElo ? `${num(pl.rankedElo)} Elo${pl.highestSeasonRankedElo ? ` · season best ${num(pl.highestSeasonRankedElo)}` : ""}` : "No ranked games this season")}
      ${tile("Trophies", num(pl.trophies), `Highest ${num(pl.highestTrophies)}`)}
      ${tile("Fame", pl.fameTierName ? esc(title(pl.fameTierName)) : "—", pl.fame ? `${num(pl.fame)} fame` : "")}
      ${tile("3v3 wins", num(pl["3vs3Victories"]), `Solo ${num(pl.soloVictories)} · Duo ${num(pl.duoVictories)}`)}
      ${tile("Experience", `Level ${num(pl.expLevel)}`, `${num(pl.expPoints)} XP`)}
      ${tile("Brawlers", num((pl.brawlers || []).length),
        pl.totalPrestigeLevel ? `${num(pl.totalPrestigeLevel)} total prestige` : "Tap the Brawlers tab for the full list")}
    </div>
    <h2>Last ${p.battles.length} game${p.battles.length === 1 ? "" : "s"}</h2>
    <div class="tiles">
      ${tile("Record", `${all.rec.w}–${all.rec.l}${all.rec.d ? `–${all.rec.d}` : ""}`, wr == null ? "" : `${pct(wr)} win rate`)}
      ${tile("Trophy change", trophyTxt(all.trophy), "Ranked games don't move trophies")}
      ${tile("Star player", `${all.star}×`)}
    </div>
    ${battleTable("p-all", p.battles)}`;
}

function viewPlayerSessions(p) {
  const sessions = toSessions(p.battles);
  if (!sessions.length) return `<p class="empty">No games in the battle log.</p>`;
  return `<p class="hint">A session is a run of games less than 30 minutes apart — the same way Corestats groups them.</p>
    ${sessions.map((s, i) => {
      const wr = winRate(s.rec);
      return `<section class="session">
        <div class="session-head">
          <h3>${esc(whenShort(s.from))} → ${esc(new Date(s.to).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</h3>
          <div class="session-sum">
            <strong>${s.rec.w}–${s.rec.l}${s.rec.d ? `–${s.rec.d}` : ""}</strong>
            ${wr == null ? "" : `<span>${pct(wr, 0)} win rate</span>`}
            <span class="${s.trophy > 0 ? "up" : s.trophy < 0 ? "down" : ""}">${trophyTxt(s.trophy)} trophies</span>
            <span>${s.battles.length} game${s.battles.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        ${battleTable("p-session-" + i, s.battles)}
      </section>`;
    }).join("")}`;
}

// Shared body for the Ranked and Friendlies views: a record, the best and worst brawler,
// then the same per-brawler, per-map and per-mode breakdown.
function breakdown(key, battles, noun) {
  const a = aggregate(battles);
  const wr = winRate(a.rec);
  const best = extreme(a.brawler, "best");
  // With only one brawler over the games threshold, best and worst are the same pick — show neither twice.
  let worst = extreme(a.brawler, "worst");
  if (best && worst && best.key === worst.key) worst = null;
  const tile = (label, value, sub = "", side = "blue") => `<div class="tile ${side}">
      <div class="tile-label">${label}</div><div class="tile-value">${value}</div>
      ${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
  const brawlerTxt = x => `${pct(x.wr, 0)} · ${x.rec.g} game${x.rec.g === 1 ? "" : "s"}`;
  const none = `No ${noun} games.`;
  return { a, html: `<div class="tiles">
      ${tile("Record", `${a.rec.w}–${a.rec.l}${a.rec.d ? `–${a.rec.d}` : ""}`, wr == null ? "" : `${pct(wr)} win rate`)}
      ${tile("Best brawler", best ? esc(title(best.name)) : "—", best ? brawlerTxt(best) : "Needs 2+ games on one brawler")}
      ${tile("Worst brawler", worst ? esc(title(worst.name)) : "—", worst ? brawlerTxt(worst) : "Needs 2+ games on a second brawler", "red")}
    </div>
    <h2>Brawlers</h2>${recTable(key + "-b", a.brawler, "Brawler", none)}
    <h2>Maps</h2>${recTable(key + "-map", a.map, "Map", none)}
    <h2>Modes</h2>${recTable(key + "-mode", a.mode, "Mode", none)}` };
}

function viewPlayerRanked(p) {
  const pl = p.player;
  const ranked = p.battles.filter(b => b.ranked);
  const tiles = `<div class="tiles">
      ${rankTile("This season", pl.rankedRankName, pl.rankedElo, "blue")}
      ${rankTile("Season best", pl.highestSeasonRankedRankName, pl.highestSeasonRankedElo, "blue")}
      ${rankTile("All-time best", pl.highestAllTimeRankedRankName, pl.highestAllTimeRankedElo, "red")}
    </div>`;
  if (!ranked.length) {
    return tiles + `<p class="empty">No Ranked games in the last ${p.battles.length} battles, so there's nothing to break
      down by map or brawler yet. The API only keeps the most recent 25 games.</p>`;
  }
  return tiles + `<p class="hint">Tiers and Elo come straight from the API. Everything below is worked out from the Ranked
      games in this player's battle log, which only goes back 25 games.</p>
    ${breakdown("p-r", ranked, "ranked").html}
    <h2>Every ranked game</h2>${battleTable("p-ranked", ranked)}`;
}

function viewPlayerFriendlies(p) {
  const friendly = p.battles.filter(b => b.friendly);
  if (!friendly.length) {
    return `<p class="empty">No friendly games in the last ${p.battles.length} battles. Scrims show up here once they're
      the most recent thing this player has played — the API only keeps 25 games, so ladder and ranked push them out.</p>`;
  }
  const { a, html } = breakdown("p-f", friendly, "friendly");
  return `<p class="hint">Scrims and club friendlies. These earn no trophies and no ranked progress, so the game itself
      keeps no record of them — this is worked out from the last ${p.battles.length} battles, of which
      ${friendly.length} ${friendly.length === 1 ? "was" : "were"} friendly. For scrim history that lasts,
      log games on the Matches tab.</p>
    ${html}
    <h2>Played with</h2>${recTable("p-fmates", a.mates, "Teammate", "No teammates in these games.")}
    <h2>Played against</h2>${recTable("p-ffoes", a.foes, "Opponent", "No opponents in these games.")}
    <h2>Every friendly game</h2>${battleTable("p-friendly", friendly)}`;
}

function viewPlayerPeople(p) {
  const a = aggregate(p.battles);
  return `<p class="hint">From the same 25 games: how it went with each teammate, and against each opponent.
      Opponent win rate is how often <em>they</em> beat this player.</p>
    <h2>Teammates</h2>${recTable("p-mates", a.mates, "Teammate", "No team games in the log.")}
    <h2>Opponents</h2>${recTable("p-foes", a.foes, "Opponent", "No opponents in the log.")}`;
}

function viewPlayerBrawlers(p) {
  const rows = p.player.brawlers || [];
  const cols = [
    { id: "name", label: "Brawler", get: b => b.name, fmt: b =>
      `<span class="bwrap"><img class="bimg" src="https://cdn.brawlify.com/brawlers/borderless/${encodeURIComponent(b.id)}.png"
        alt="" loading="lazy" onerror="this.remove()"><strong>${esc(title(b.name))}</strong></span>` },
    { id: "power", label: "Power", num: true, get: b => b.power },
    { id: "rank", label: "Rank", num: true, get: b => b.rank },
    { id: "prestige", label: "Prestige", num: true, get: b => b.prestigeLevel },
    { id: "trophies", label: "Trophies", num: true, get: b => b.trophies },
    { id: "highest", label: "Highest", num: true, get: b => b.highestTrophies },
    { id: "streak", label: "Win streak", num: true, get: b => b.currentWinStreak,
      fmt: b => `${b.currentWinStreak ?? 0}${b.maxWinStreak ? ` <span class="muted">/ ${b.maxWinStreak}</span>` : ""}` },
    { id: "hc", label: "Hypercharge", get: b => ((b.hyperCharges || []).length ? 1 : 0),
      fmt: b => ((b.hyperCharges || []).length ? esc(title(b.hyperCharges[0].name)) : "—") },
    { id: "skin", label: "Skin", get: b => (b.skin && b.skin.name) || "",
      fmt: b => (b.skin && b.skin.name ? esc(title(b.skin.name.replace(/\n/g, " "))) : "—") },
    { id: "gears", label: "Gears", get: b => (b.gears || []).length,
      fmt: b => esc((b.gears || []).map(g => title(g.name)).join(", ")) || "—" },
    { id: "sp", label: "Star powers", num: true, get: b => (b.starPowers || []).length },
    { id: "gadgets", label: "Gadgets", num: true, get: b => (b.gadgets || []).length },
  ];
  const maxed = rows.filter(b => (b.hyperCharges || []).length).length;
  return `<p class="hint">${rows.length} brawler${rows.length === 1 ? "" : "s"} unlocked, ${maxed} with a hypercharge.
      Win streak shows current / best. Sort by any column.</p>
    ${table("p-brawlers", cols, rows, { defaultSort: { col: "trophies", dir: -1 }, empty: "No brawlers in this profile." })}`;
}

function viewPlayers() {
  if (!PROXY_READY) {
    return `<div class="notice"><h2>Live player stats aren't switched on yet</h2>
      <p>This tab reads live profiles straight from Supercell's Brawl Stars API. That API's key can't live in this
        website's code — the repo is public, and keys only work from one fixed IP address. So it sits in a tiny free
        Cloudflare Worker instead, and the site asks the worker.</p>
      <p>The worker and its setup steps are in <code>worker/README.md</code> — about five minutes, no credit card.
        When it's running, paste its address into <code>PROXY_URL</code> in <code>config.js</code> and this tab turns on.</p></div>`;
  }
  const p = state.profile;
  const head = `<div class="bar"><h2>Players</h2>
      ${p && p.player ? `<button class="btn btn-ghost" data-act="refreshprofile">Refresh</button>` : ""}</div>
    <form class="addrow tagform" data-form="tag">
      <input name="tag" placeholder="#Y2PLQQCGP" value="${esc(state.tagInput)}" maxlength="16" aria-label="Player tag" autocapitalize="characters" spellcheck="false">
      <button class="btn btn-gold" type="submit">Look up</button>
    </form>
    ${savedTags()}`;

  if (!p) {
    return head + `<p class="hint">Type a player tag to see their live profile: trophies, brawlers, and everything
      calculable from their last 25 games — sessions, ranked win rates, and records with each teammate and opponent.
      A tag is in the game under your name, and looks like <code>#Y2PLQQCGP</code>.</p>
      <p class="hint">This is a live snapshot. Your Matches tab is still what gives the team long-term history.</p>`;
  }
  if (p.loading) return head + `<p class="empty">Loading #${esc(p.tag)}…</p>`;
  if (p.error) return head + `<div class="notice"><h2>Couldn't load #${esc(p.tag)}</h2><p>${esc(p.error)}</p></div>`;

  const pl = p.player;
  // The in-game name colour is picked for a dark background; skip it when it would wash out here.
  let color = /^0x[0-9a-fA-F]{8}$/.test(pl.nameColor || "") ? "#" + pl.nameColor.slice(-6) : "";
  if (color) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    if (0.299 * r + 0.587 * g + 0.114 * b > 190) color = "";
  }
  const subs = [["overview", "Overview"], ["sessions", "Sessions"], ["ranked", "Ranked"], ["friendlies", "Friendlies"],
    ["people", "Teammates & opponents"], ["brawlers", "Brawlers"]];
  const views = { overview: viewPlayerOverview, sessions: viewPlayerSessions, ranked: viewPlayerRanked,
    friendlies: viewPlayerFriendlies, people: viewPlayerPeople, brawlers: viewPlayerBrawlers };
  const sub = views[state.pSub] ? state.pSub : "overview";
  return head + `<section class="phead">
      <h2 ${color ? `style="color:${esc(color)}"` : ""}>${esc(pl.name || "")}</h2>
      <span class="ptag">#${esc(p.tag)}</span>
      ${pl.club && pl.club.name ? `<span class="chip blue">${esc(pl.club.name)}</span>` : ""}
    </section>
    <div class="subtabs">${subs.map(([id, label]) =>
      `<button class="subtab${sub === id ? " on" : ""}" data-psub="${id}">${label}</button>`).join("")}</div>
    ${views[sub](p)}`;
}

// ---------------- ranked ladder ----------------
// The ladder is everyone the site has ever looked up who was Mythic I or above.
// It fills as people search themselves, so it starts empty on a fresh database.
function loadLadder(limit = 100) {
  state.ladder = { loading: true };
  render();
  fetchLadder(limit).then(
    d => { state.ladder = d; render(); },
    e => { state.ladder = { error: e.message || String(e) }; render(); }
  );
}

const TIER_CLASS = n => {
  const t = String(n || "").toLowerCase();
  return t.startsWith("pro") ? "t-pro" : t.startsWith("master") ? "t-master"
    : t.startsWith("legendary") ? "t-legend" : t.startsWith("mythic") ? "t-mythic" : "t-other";
};

function viewLadder() {
  if (!PROXY_READY) {
    return `<div class="notice"><h2>The ladder isn't switched on yet</h2>
      <p>It needs the stats worker from <code>worker/README.md</code>, plus its ladder database.</p></div>`;
  }
  const L = state.ladder;
  if (L === null) { loadLadder(state.ladderShown); return `<p class="empty">Loading the ladder…</p>`; }
  if (L.loading) return `<p class="empty">Loading the ladder…</p>`;
  if (L.error) {
    return `<div class="notice"><h2>Couldn't load the ladder</h2><p>${esc(L.error)}</p>
      <p>If this says there's no database yet, the setup steps are in <code>worker/README.md</code>.</p></div>`;
  }
  const head = `<div class="bar"><h2>Ranked ladder</h2>
      <button class="btn btn-ghost" data-act="reloadladder">Refresh</button></div>`;
  if (!L.players.length) {
    return head + `<div class="notice"><h2>Nobody on the ladder yet</h2>
      <p>The crawler fills this from the game's country rankings, a country at a time, keeping everyone at
        Masters II or above. Looking a tag up in <strong>Player lookup</strong> adds them straight away.</p></div>`;
  }
  const big = L.tiers.reduce((a, t) => Math.max(a, t.n), 0) || 1;
  const strip = `<div class="ladder-sum">
      <span><strong>${num(L.total)}</strong> player${L.total === 1 ? "" : "s"} tracked</span>
      <span>Season <strong>${esc(String(L.season || "—"))}</strong></span>
      ${L.updated ? `<span>Last sync ${esc(whenShort(L.updated))}</span>` : ""}
    </div>
    <div class="dist">${L.tiers.map(t => `<div class="dist-row">
        <span class="dist-name">${esc(title(t.rank_name))}</span>
        <span class="dist-bar"><i class="${TIER_CLASS(t.rank_name)}" style="width:${(t.n / big) * 100}%"></i></span>
        <span class="dist-n">${num(t.n)}</span>
      </div>`).join("")}</div>`;

  const rows = L.players.map((p, i) => `<tr>
      <td class="num pos">${i + 1}</td>
      <td><button class="link" data-act="loadtag" data-id="${esc(p.tag)}">${esc(p.name)}</button>
        <span class="ptag small">#${esc(p.tag)}</span></td>
      <td><span class="tier ${TIER_CLASS(p.rank_name)}">${esc(title(p.rank_name))}</span></td>
      <td class="num"><strong>${num(p.elo)}</strong></td>
      <td class="num">${p.best_elo ? num(p.best_elo) : ""}</td>
      <td>${p.club ? esc(p.club) : ""}</td>
      <td class="num muted">${esc(whenShort(p.updated))}</td>
    </tr>`).join("");

  return head + strip + `<p class="hint">Ranked by Elo straight from Supercell, so a player's place here matches what
      they see in game. Only Masters II and above are listed. Tap a name to open their full profile.</p>
    <div class="scroll"><table class="tbl plain"><thead><tr>
      <th class="num">#</th><th>Player</th><th>Tier</th><th class="num">Elo</th>
      <th class="num">Season best</th><th>Club</th><th class="num">Synced</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    ${L.players.length < L.total
      ? `<button class="btn btn-ghost more" data-act="moreladder">Show more (${num(L.total - L.players.length)} left)</button>`
      : ""}`;
}

// ---------------- render ----------------
function render() {
  renderTop();
  const el = main();
  // These read the live API, not your database, so they work before the lists load.
  if (state.section === "players") { el.innerHTML = viewPlayers(); return; }
  if (state.section === "ladder") { el.innerHTML = viewLadder(); return; }
  if (state.readError && !state.lists) {
    el.innerHTML = `<div class="notice"><h2>Sign in to see the stats</h2><p>${esc(state.readError)}</p>
      ${!state.user && LIVE ? `<button class="btn btn-gold" data-act="signin">Sign in with Google</button>` : ""}</div>`;
    return;
  }
  if (state.lists === undefined) { el.innerHTML = `<p class="empty">Loading…</p>`; return; }
  if (state.lists === null) {
    el.innerHTML = `<div class="notice"><h2>Set up your lists</h2>
      ${canEdit() ? `<p>Start with 91 brawlers, 26 maps and the 6 ranked modes. You can add, rename and remove them afterwards.</p>
        <button class="btn btn-gold" data-act="seed">Load starter lists</button>`
        : `<p>Someone on the team needs to sign in once to set this up.</p>
           <button class="btn btn-gold" data-act="signin">Sign in with Google</button>`}</div>`;
    return;
  }
  const S = computeStats(state.matches, state.lists, state.filter);
  const views = {
    dashboard: () => viewDashboard(S), log: viewLog, matches: () => viewMatches(S),
    team: () => viewSide("team", S), enemy: () => viewSide("enemy", S), lists: viewLists,
  };
  el.innerHTML = (views[state.tab] || views.dashboard)();
}

// ---------------- list editing ----------------
function checkName(list, name, exceptId) {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new Error("Type a name first.");
  if (n.length > 40) throw new Error("Names can be up to 40 characters.");
  if (list.some(x => x.id !== exceptId && x.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" is already on the list.`);
  return n;
}
function uniqueId(list, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  let id = base;
  while (list.some(x => x.id === id)) id = base + "-" + Math.random().toString(36).slice(2, 6);
  return id;
}

// ---------------- CSV ----------------
function toCsv(list) {
  const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows = [["Date", "Mode", "Map", "Blue 1", "Blue 2", "Blue 3", "Result", "Red 1", "Red 2", "Red 3"]];
  for (const m of list) {
    rows.push([m.date, names.mode.get(m.mode) || "", names.map.get(m.map) || "", ...m.blue.map(bName), RESULTS[m.result], ...m.red.map(bName)]);
  }
  return rows.map(r => r.map(v => q(String(v))).join(",")).join("\n");
}
function parseCsv(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function parseDate(s) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US month/day/year
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}
async function importCsv(file) {
  const rows = parseCsv(await file.text()).filter(r => r.some(c => c.trim()));
  if (!rows.length) throw new Error("That file is empty.");
  const L = state.lists;
  const find = (list, v) => list.find(x => x.name.toLowerCase() === String(v || "").trim().toLowerCase());
  let idx = { date: 0, mode: 1, map: 2, b: [3, 4, 5], res: 6, r: [7, 8, 9] };
  const head = rows[0].map(h => h.trim().toLowerCase());
  if (head.includes("date")) {
    const at = n => head.indexOf(n);
    idx = { date: at("date"), mode: at("mode"), map: at("map"), b: ["blue 1", "blue 2", "blue 3"].map(at),
      res: head.findIndex(h => h.startsWith("result")), r: ["red 1", "red 2", "red 3"].map(at) };
    rows.shift();
    if ([idx.date, idx.map, idx.res, ...idx.b, ...idx.r].some(i => i < 0)) {
      throw new Error("Couldn't find the Date, Map, Blue 1–3, Result and Red 1–3 columns in that file.");
    }
  }
  const ok = [], skipped = [];
  const resMap = { win: "W", w: "W", loss: "L", l: "L", lose: "L", draw: "D", d: "D" };
  rows.forEach((r, i) => {
    const line = i + (head.includes("date") ? 2 : 1);
    if (![idx.date, idx.map, ...idx.b, ...idx.r].some(k => (r[k] || "").trim())) return; // blank sheet row
    const map = find(L.maps, r[idx.map]);
    const names6 = [...idx.b, ...idx.r].map(k => r[k]);
    const ids = names6.map(n => (find(L.brawlers, n) || {}).id || "");
    const m = {
      id: newId() + i, date: parseDate(r[idx.date] || ""), map: map ? map.id : "",
      mode: map ? map.mode : (find(L.modes, r[idx.mode]) || {}).id || "",
      blue: ids.slice(0, 3), red: ids.slice(3), result: resMap[String(r[idx.res] || "").trim().toLowerCase()] || "",
      at: Date.now() + i,
    };
    let err = validateMatch(m, L);
    const missing = names6.filter((n, k) => n && n.trim() && !ids[k]);
    if (missing.length) err = `unknown brawler "${missing[0].trim()}"`;
    if (!map && (r[idx.map] || "").trim()) err = `unknown map "${r[idx.map].trim()}"`;
    if (err) skipped.push(`row ${line}: ${err}`); else ok.push(m);
  });
  if (!ok.length) throw new Error("No games could be imported. " + skipped.slice(0, 3).join("; "));
  if (!confirm(`Import ${ok.length} game${ok.length === 1 ? "" : "s"}?${skipped.length ? `\n\n${skipped.length} row(s) will be skipped:\n` + skipped.slice(0, 8).join("\n") + (skipped.length > 8 ? "\n…" : "") : ""}`)) return;
  await store.addMatches(ok);
  toast(`Imported ${ok.length} game${ok.length === 1 ? "" : "s"}${skipped.length ? `, skipped ${skipped.length}` : ""}.`);
}

// ---------------- events ----------------
function onClick(e) {
  const t = e.target.closest("button, [data-tab]");
  if (!t) return;
  if (t.dataset.tab) {
    if (state.tab === "log" && t.dataset.tab !== "log" && state.editing) { state.editing = null; state.form = null; }
    state.tab = t.dataset.tab; state.search = ""; state.rowLimit = 300; state.limit = 50;
    window.scrollTo({ top: 0 });
    render(); return;
  }
  if (t.dataset.section) {
    state.section = t.dataset.section;
    const tabs = SECTION_TABS[state.section];
    if (tabs.length && !tabs.some(([id]) => id === state.tab)) state.tab = tabs[0][0];
    state.search = ""; window.scrollTo({ top: 0 }); render(); return;
  }
  if (t.dataset.psub) { state.pSub = t.dataset.psub; window.scrollTo({ top: 0 }); render(); return; }
  if (t.dataset.sub) {
    const [side, sub] = t.dataset.sub.split(":"); state.sub[side] = sub; state.search = ""; state.rowLimit = 300; render(); return;
  }
  if (t.dataset.sort) {
    const [key, col] = t.dataset.sort.split(":");
    const cur = state.sort[key];
    state.sort[key] = { col, dir: cur && cur.col === col ? -cur.dir : (col === "name" || col === "t" || col === "mo" ? 1 : -1) };
    render(); return;
  }
  if (t.dataset.result) { state.form.result = t.dataset.result; render(); return; }
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case "signin": run(() => store.signIn()); break;
    case "signout": run(() => store.signOut()); break;
    case "seed": run(() => store.seedLists(), "Starter lists loaded."); break;
    case "resetdemo": if (confirm("Reset the demo? This clears the demo games saved in this browser.")) store.resetDemo(); break;
    case "morerows": state.rowLimit += 300; render(); break;
    case "moregames": state.limit += 50; render(); break;
    case "clearform": state.form = null; render(); break;
    case "canceledit": state.editing = null; state.form = null; state.tab = "matches"; render(); break;
    case "edit": {
      const m = state.matches.find(x => x.id === id); if (!m) return;
      state.editing = m;
      state.form = { date: m.date, mode: (state.lists.maps.find(x => x.id === m.map) || {}).mode || m.mode, map: m.map,
        blue: [...m.blue], red: [...m.red], result: m.result };
      state.tab = "log"; window.scrollTo({ top: 0 }); render(); break;
    }
    case "delete": {
      const m = state.matches.find(x => x.id === id); if (!m) return;
      if (confirm(`Delete the ${m.date} game on ${names.map.get(m.map) || "this map"}?`)) run(() => store.deleteMatch(m), "Match deleted.");
      break;
    }
    case "export": {
      const S = computeStats(state.matches, state.lists, state.filter);
      const blob = new Blob([toCsv(S.filtered)], { type: "text/csv" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `brawl-matches-${today()}.csv` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      break;
    }
    case "remove": {
      const kind = t.dataset.kind;
      run(() => store.saveLists(L => {
        const used = usage();
        if (kind === "brawlers" && used.b.get(id)) throw new Error("That brawler is used in games, so it can't be deleted.");
        if (kind === "maps" && used.map.get(id)) throw new Error("That map is used in games, so it can't be deleted.");
        if (kind === "modes" && (used.mode.get(id) || L.maps.some(m => m.mode === id))) throw new Error("That mode is still used, so it can't be deleted.");
        L[kind] = L[kind].filter(x => x.id !== id); return L;
      }), "Deleted.");
      break;
    }
    case "loadtag": state.tagInput = "#" + normTag(id); loadProfile(id); break;
    case "reloadladder": loadLadder(state.ladderShown); break;
    case "moreladder": state.ladderShown += 100; loadLadder(state.ladderShown); break;
    case "refreshprofile": forget(state.profile.tag); loadProfile(state.profile.tag); break;
    case "savetag": {
      const pl = state.profile.player;
      const tag = normTag(pl.tag || state.profile.tag), label = pl.name || tag;
      run(() => store.savePlayers(list => {
        if (list.some(x => normTag(x.tag) === tag)) return list;
        return [...list, { tag, label }].sort((a, b) => (a.label || a.tag).localeCompare(b.label || b.tag));
      }), `${label} saved.`);
      break;
    }
    case "untag":
      run(() => store.savePlayers(list => list.filter(x => normTag(x.tag) !== normTag(id))), "Removed.");
      break;
  }
}

function onChange(e) {
  const t = e.target;
  if (t.id === "f-from" || t.id === "f-to" || t.id === "f-min") {
    state.filter = { from: $("#f-from").value, to: $("#f-to").value, minGames: Math.max(0, parseInt($("#f-min").value, 10) || 0) };
    persistUi(); render(); return;
  }
  if (t.dataset.act === "onlyplayed") { state.onlyPlayed = t.checked; persistUi(); render(); return; }
  if (t.dataset.act === "import") { const file = t.files[0]; t.value = ""; if (file) run(() => importCsv(file)); return; }
  if (t.dataset.field && state.form) {
    const f = state.form, k = t.dataset.field;
    if (k === "blue" || k === "red") f[k][Number(t.dataset.i)] = t.value;
    else f[k] = t.value;
    if (k === "mode") f.map = (state.lists.maps.filter(m => m.mode === f.mode).sort(byName)[0] || {}).id || "";
    if (k !== "date") render();
    return;
  }
  if (t.dataset.rename) {
    const [kind, id] = t.dataset.rename.split(":");
    run(() => store.saveLists(L => {
      const x = L[kind].find(i => i.id === id); if (!x) return L;
      x.name = checkName(L[kind], t.value, id); return L;
    }), "Renamed.").then(render);
    return;
  }
  if (t.dataset.mapmode) {
    const id = t.dataset.mapmode;
    run(() => store.saveLists(L => { const m = L.maps.find(i => i.id === id); if (m) m.mode = t.value; return L; }), "Map mode updated.");
  }
}

function onInput(e) {
  if (e.target.name === "tag") { state.tagInput = e.target.value; return; } // no re-render: keeps the caret put
  if (e.target.dataset.act === "search") {
    state.search = e.target.value; state.rowLimit = 300;
    const pos = e.target.selectionStart;
    render();
    const s = $(".search"); if (s) { s.focus(); s.setSelectionRange(pos, pos); }
  }
}

function onSubmit(e) {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  if (kind === "log") {
    const f = state.form;
    const m = { date: f.date, mode: f.mode, map: f.map, blue: f.blue, red: f.red, result: f.result };
    const err = validateMatch(m, state.lists);
    if (err) { toast(err, true); return; }
    if (state.editing) {
      const old = state.editing;
      run(async () => { await store.updateMatch(old, m); state.editing = null; state.form = null; state.tab = "matches"; render(); }, "Changes saved.");
    } else {
      run(async () => {
        await store.addMatches([{ ...m, id: newId() }]);
        state.form = { ...f, blue: ["", "", ""], red: ["", "", ""], result: "" }; // keep date, mode and map for the next game
        render();
      }, "Match saved.");
    }
    return;
  }
  if (kind === "tag") { state.tagInput = form.tag.value; loadProfile(form.tag.value); return; }
  const listKind = kind.replace("add-", "");
  const name = form.name.value;
  const mode = form.mode ? form.mode.value : "";
  run(() => store.saveLists(L => {
    const n = checkName(L[listKind], name);
    const item = { id: uniqueId(L[listKind], n), name: n };
    if (listKind === "maps") {
      if (!mode) throw new Error("Pick the map's mode.");
      item.mode = mode;
    }
    L[listKind].push(item); return L;
  }), "Added.");
}

// ---------------- start ----------------
document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
document.addEventListener("input", onInput);
document.addEventListener("submit", onSubmit);
$("#f-clear").addEventListener("click", () => { state.filter = { ...state.filter, from: "", to: "" }; persistUi(); render(); });

(async () => {
  render();
  try {
    store = await createStore({
      lists: L => { state.lists = L; state.readError = ""; if (L) indexLists(); render(); },
      matches: ms => { state.matches = ms; render(); },
      players: ps => { state.players = ps; render(); },
      user: u => { state.user = u; render(); },
      error: msg => { state.readError = msg; render(); },
    });
  } catch (e) {
    main().innerHTML = `<div class="notice"><h2>Couldn't connect to Firebase</h2><p>${esc(e.message)}</p>
      <p>Check the firebaseConfig in config.js.</p></div>`;
  }
})();
