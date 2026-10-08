// Pure stat calculations. No browser or Firebase code in here.

export const RESULTS = { W: "Win", L: "Loss", D: "Draw" };
const FLIP = { W: "L", L: "W", D: "D" };

export function emptyRec() { return { g: 0, w: 0, l: 0, d: 0 }; }
export function winRate(r) { return r && r.w + r.l > 0 ? r.w / (r.w + r.l) : null; }

function bump(r, res) {
  r.g++;
  if (res === "W") r.w++; else if (res === "L") r.l++; else r.d++;
}
function add(map, key, res) {
  let r = map.get(key);
  if (!r) { r = emptyRec(); map.set(key, r); }
  bump(r, res);
}

export function inRange(m, f) {
  if (f.from && m.date < f.from) return false;
  if (f.to && m.date > f.to) return false;
  return true;
}

export function sortNewest(matches) {
  return [...matches].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.at || 0) - (a.at || 0)));
}

// Checks a match against the current lists. Returns an error message, or "" if it is fine.
export function validateMatch(m, lists) {
  const ids = new Set(lists.brawlers.map(b => b.id));
  const map = lists.maps.find(x => x.id === m.map);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date || "")) return "Pick a date.";
  if (!map) return "Pick a map.";
  if (!lists.modes.some(x => x.id === m.mode)) return "Pick a mode.";
  const all = [...(m.blue || []), ...(m.red || [])];
  if (all.length !== 6 || all.some(x => !x)) return "Pick all six brawlers.";
  if (all.some(x => !ids.has(x))) return "One of the brawlers isn't on the Lists page.";
  if (new Set(all).size !== 6) return "The same brawler is picked twice.";
  if (!RESULTS[m.result]) return "Pick Win, Loss or Draw.";
  return "";
}

// Team = blue brawlers (your team). Enemy = red brawlers. Results are flipped for the enemy side.
// Mode stats use each map's mode from the Lists page, so they always add up from the map stats.
export function computeStats(matches, lists, filter) {
  const mapMode = new Map(lists.maps.map(m => [m.id, m.mode]));
  const filtered = sortNewest(matches.filter(m => inRange(m, filter)));
  const totals = emptyRec();
  const side = () => ({ brawler: new Map(), map: new Map(), mode: new Map() });
  const team = side(), enemy = side();
  for (const m of filtered) {
    bump(totals, m.result);
    const mode = mapMode.get(m.map) || m.mode;
    for (const [s, ids, res] of [[team, m.blue, m.result], [enemy, m.red, FLIP[m.result]]]) {
      for (const b of ids) {
        add(s.brawler, b, res);
        add(s.map, b + "|" + m.map, res);
        add(s.mode, b + "|" + mode, res);
      }
    }
  }
  return { filtered, totals, team, enemy };
}

// Picks a brawler for the dashboard tiles. kind: "most" | "best" | "worst".
export function pick(sideStats, lists, kind, minGames) {
  let best = null;
  for (const b of lists.brawlers) {
    const r = sideStats.brawler.get(b.id);
    if (!r) continue;
    if (kind === "most") {
      if (!best || r.g > best.r.g) best = { b, r };
      continue;
    }
    const wr = winRate(r);
    if (wr === null || r.g < Math.max(1, minGames)) continue;
    const better = !best || (kind === "best" ? wr > best.wr : wr < best.wr);
    if (better) best = { b, r, wr };
  }
  return best;
}
