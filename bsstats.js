// Battle-log analytics. Pure functions — no browser, Firebase or network code in here.
// Everything is worked out from the API's battle log, because Supercell hands over no
// ranked tier and no stats beyond the last 25 games.
import { emptyRec, winRate } from "./stats.js";

export { winRate };
export const SESSION_GAP = 30 * 60 * 1000; // games less than 30 min apart are one session

// Ranked (the Bronze→Masters mode). Trophy ladder games are type "ranked", confusingly.
const RANKED = new Set(["soloranked", "teamranked"]);
const RESULT = { victory: "W", defeat: "L", draw: "D" };

export const sameTag = (a, b) => normish(a) === normish(b);
const normish = t => String(t || "").replace(/^#/, "").toUpperCase();

// "20260101T120000.000Z" -> ms
export function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(s || ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

// "gemGrab" -> "Gem Grab"
export function pretty(s) {
  const t = String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function bump(rec, res) {
  rec.g++;
  if (res === "W") rec.w++; else if (res === "L") rec.l++; else if (res === "D") rec.d++;
}
function into(map, key, name, res) {
  let e = map.get(key);
  if (!e) { e = { key, name, rec: emptyRec() }; map.set(key, e); }
  bump(e.rec, res);
}

// One battle-log entry -> a flat shape the views can use.
function readBattle(item, meTag) {
  const b = item.battle || {};
  const ev = item.event || {};
  const type = String(b.type || "").toLowerCase();
  const teams = Array.isArray(b.teams) ? b.teams : null;
  const roster = Array.isArray(b.players) ? b.players : null;

  let me = null, mates = [], foes = [];
  if (teams) {
    const mine = teams.findIndex(t => Array.isArray(t) && t.some(p => sameTag(p.tag, meTag)));
    if (mine >= 0) {
      me = teams[mine].find(p => sameTag(p.tag, meTag));
      mates = teams[mine].filter(p => !sameTag(p.tag, meTag));
      foes = teams.filter((_, i) => i !== mine).flat();
    } else {
      foes = teams.flat(); // spectated or the tag isn't in this battle
    }
  } else if (roster) { // showdown: everyone in one list
    me = roster.find(p => sameTag(p.tag, meTag)) || null;
    foes = roster.filter(p => !sameTag(p.tag, meTag));
  }

  const trophyChange = typeof b.trophyChange === "number" ? b.trophyChange : null;
  let result = RESULT[String(b.result || "").toLowerCase()] || null;
  // Showdown reports a placing instead of a result; the trophy change says how it went.
  if (!result && trophyChange != null) result = trophyChange > 0 ? "W" : trophyChange < 0 ? "L" : "D";

  return {
    at: parseTime(item.battleTime),
    type,
    ranked: RANKED.has(type),
    friendly: type === "friendly", // scrims and club friendlies; no trophies, no ranked progress
    mode: pretty(b.mode || ev.mode),
    map: ev.map || "",
    result,
    rank: typeof b.rank === "number" ? b.rank : null,
    trophyChange,
    brawler: (me && me.brawler && me.brawler.name) || "",
    brawlerId: (me && me.brawler && me.brawler.id) || null,
    starPlayer: Boolean(b.starPlayer && sameTag(b.starPlayer.tag, meTag)),
    mates,
    foes,
  };
}

export function readBattles(items, meTag) {
  return (items || []).map(i => readBattle(i, meTag)).sort((a, b) => b.at - a.at);
}

// Corestats-style sessions: newest first, split wherever there's a gap of 30+ minutes.
export function toSessions(battles) {
  const out = [];
  for (const b of battles) {
    const last = out[out.length - 1];
    if (last && last.from - b.at < SESSION_GAP) last.battles.push(b);
    else out.push({ battles: [b] });
    out[out.length - 1].from = b.at;
  }
  for (const s of out) {
    s.to = s.battles[0].at;
    s.rec = emptyRec();
    s.trophy = 0;
    for (const b of s.battles) {
      bump(s.rec, b.result);
      if (b.trophyChange) s.trophy += b.trophyChange;
    }
  }
  return out;
}

// Records by map, mode, brawler, and by the people played with and against.
export function aggregate(battles) {
  const out = {
    rec: emptyRec(), trophy: 0, star: 0,
    map: new Map(), mode: new Map(), brawler: new Map(), mates: new Map(), foes: new Map(),
  };
  for (const b of battles) {
    bump(out.rec, b.result);
    if (b.trophyChange) out.trophy += b.trophyChange;
    if (b.starPlayer) out.star++;
    if (b.map) into(out.map, b.map, b.map, b.result);
    if (b.mode) into(out.mode, b.mode, b.mode, b.result);
    if (b.brawler) into(out.brawler, b.brawler, b.brawler, b.result);
    // A teammate's record is your result; an opponent's is the other way round.
    for (const p of b.mates) into(out.mates, normish(p.tag), p.name || p.tag, b.result);
    const flipped = b.result === "W" ? "L" : b.result === "L" ? "W" : b.result;
    for (const p of b.foes) into(out.foes, normish(p.tag), p.name || p.tag, flipped);
  }
  return out;
}

// Best or worst entry of a Map from aggregate(), ignoring anything under minGames.
export function extreme(map, kind, minGames = 2) {
  let best = null;
  for (const e of map.values()) {
    const wr = winRate(e.rec);
    if (wr == null || e.rec.g < minGames) continue;
    if (!best || (kind === "best" ? wr > best.wr : wr < best.wr)) best = { ...e, wr };
  }
  return best;
}
