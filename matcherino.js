import { PROXY_URL } from "./config.js";

export const EXAMPLE_MATCHERINO = "https://matcherino.com/supercell/tournaments/224155/bracket/match-252419794";
export const MATCH_METRICS = [
  ["kills", "Kills", "kills"], ["deaths", "Deaths", "deaths"], ["damageDealt", "Damage", "damage"],
  ["healingDone", "Healing", "healing"], ["damageReceived", "Damage taken", "shield"],
  ["gadgetUsedCount", "Gadgets used", "gadget"], ["superUsedCount", "Supers used", "super"],
];
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const number = value => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
const image = value => {
  try { const u = new URL(value); return u.protocol === "https:" && ["cdn.matcherino.com", "cdn.brawlify.com"].includes(u.hostname) ? esc(u.href) : ""; }
  catch { return ""; }
};

export function parseMatcherinoLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Paste the full Matcherino match link."); }
  const match = url.pathname.match(/^\/supercell\/tournaments\/([1-9]\d{0,11})\/bracket\/match-([1-9]\d{0,11})\/?$/);
  if (url.protocol !== "https:" || !["matcherino.com", "www.matcherino.com"].includes(url.hostname) || url.port || url.username || url.password || !match) {
    throw new Error("Use a Matcherino bracket link ending in /bracket/match- followed by the match number.");
  }
  return { tournament: match[1], match: match[2] };
}

export async function fetchMatcherino(link) {
  const ids = parseMatcherinoLink(link);
  const response = await fetch(`${PROXY_URL.replace(/\/+$/, "")}/matcherino?tournament=${ids.tournament}&match=${ids.match}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error("The stats service returned an unreadable reply."); }
  if (!response.ok) throw new Error(body.error || "Couldn't load Matcherino stats.");
  if (!Array.isArray(body.teams) || body.teams.length !== 2 || !Array.isArray(body.sets)) throw new Error("Matcherino reports aren't available for this match.");
  return body;
}

export function setPlayers(set, index) {
  const rows = new Map();
  for (const game of set.games) {
    for (const p of game.teams[index]?.players || []) {
      const key = p.tag || p.name;
      if (!rows.has(key)) rows.set(key, { ...p, appearances: 0, brawlers: new Map(), totals: {}, ping: [] });
      const row = rows.get(key);
      row.appearances++;
      row.brawlers.set(p.brawler.id || p.brawler.name, p.brawler);
      for (const [metric] of MATCH_METRICS) {
        const value = p.stats[metric];
        if (row.totals[metric] === null || typeof value !== "number") row.totals[metric] = null;
        else row.totals[metric] = (row.totals[metric] || 0) + value;
      }
      row.ping.push({ game: game.number, value: p.stats.averageLatency });
    }
  }
  return [...rows.values()];
}

function playerCard(player, set) {
  const portraits = [...player.brawlers.values()].map(b => {
    const src = image(b.image);
    return `<div class="mt-portrait">${src ? `<img src="${src}" alt="${esc(b.name)}" loading="lazy" referrerpolicy="no-referrer">` : `<div class="mt-noimage">?</div>`}
      <span>${esc(b.name)}</span>${b.gadget || b.starPower ? `<small>${esc([b.gadget, b.starPower].filter(Boolean).join(" · "))}</small>` : ""}</div>`;
  }).join("");
  return `<article class="mt-player"><h4>${esc(player.name)}</h4><p class="mt-tag">${esc(player.tag)}</p>
    <div class="mt-portraits">${portraits}</div>
    <dl>${MATCH_METRICS.map(([key, label, icon]) => `<div><dt><img class="mt-stat-icon" src="./assets/stats/${icon}.webp" alt="" width="18" height="18"> ${label}</dt><dd>${number(player.totals[key])}</dd></div>`).join("")}
      <div class="mt-ping"><dt>Ping</dt><dd>${player.ping.map(p => `<span>Game ${p.game}: ${number(p.value)}${typeof p.value === "number" ? " ms" : ""}</span>`).join("")}</dd></div>
    </dl>${player.appearances < set.games.length ? `<p class="mt-partial">Stats from ${player.appearances} of ${set.games.length} reported games</p>` : ""}
    </article>`;
}

function setView(set, match) {
  const wins = match.teams.map(t => set.games.filter(g => g.winner === t.id).length);
  const complete = set.games.every(g => match.teams.some(t => t.id === g.winner) || g.draw > 0);
  const maps = [...new Map(set.games.map(g => [g.map.id || g.map.name, g.map])).values()];
  const sides = match.teams.map((team, index) => {
    const rows = setPlayers(set, index);
    const anyData = rows.length > 0;
    const won = complete && wins[index] > wins[1 - index];
    const lost = complete && wins[index] < wins[1 - index];
    const bans = [...new Map(set.games.flatMap(g => g.teams[index]?.bans || []).map(b => [b.id || b.name, b])).values()];
    return `<section class="mt-side mt-side-${index}"><div class="mt-sidehead"><span>${won ? "VICTORY!" : lost ? "DEFEAT" : "RESULT PENDING"}</span><strong>${esc(team.name)}</strong><b>${wins[index]} game wins</b></div>
      ${bans.length ? `<p class="mt-bans">Bans: ${bans.map(b => esc(b.name)).join(" · ")}</p>` : ""}
      <div class="mt-players">${anyData ? rows.map(p => playerCard(p, set)).join("") : team.players.map(p => `<article class="mt-player"><h4>${esc(p.name)}</h4><p class="mt-tag">${esc(p.tag)}</p><p>Detailed player stats not reported.</p></article>`).join("") || "<p>Roster not reported.</p>"}</div></section>`;
  }).join("");
  const detailed = set.games.filter(g => g.teams.some(t => t.players.length)).length;
  return `<section class="mt-set"><div class="mt-sethead"><h3>Set ${set.number}</h3><span>${set.games.length} reported games · totals across the set</span></div>
    <div class="mt-board"><aside class="mt-maps">${maps.map(m => {
      const src = image(m.image);
      return `<strong>${esc(m.name)}</strong><span>${esc(m.mode)}</span>${src ? `<img src="${src}" alt="Map layout: ${esc(m.name)}" loading="lazy" referrerpolicy="no-referrer">` : ""}`;
    }).join("")}</aside>${sides}</div>
    <p class="mt-coverage">${detailed} of ${set.games.length} games include detailed player reports. “—” means not reported; ping is shown separately for each game.${detailed < set.games.length ? " Totals cover available reports only." : ""}</p>
    <details class="mt-games"><summary>Game results and duration</summary>${set.games.map(g => `<p>Game ${g.number} · ${esc(g.map.name)} · ${esc(match.teams.find(t => t.id === g.winner)?.name || (g.draw > 0 ? "Draw" : "Winner not reported"))}${g.winner ? " won" : ""} · ${g.duration == null ? "Duration not reported" : `${number(g.duration)} seconds`}</p>`).join("")}</details>
    </section>`;
}

export function viewMatcherino(state, proxyReady) {
  const form = `<section class="logform mt-form"><h2>Matcherino stats</h2><p class="hint">Paste a Brawl Stars match link to see teams, set results, brawlers, and player stats.</p>
    <form data-form="matcherino"><label for="matcherino-link">Matcherino bracket match link</label><div class="addrow"><input id="matcherino-link" name="matcherinoLink" type="url" required placeholder="https://matcherino.com/supercell/tournaments/…/bracket/match-…" value="${esc(state.link || "")}"><button class="btn btn-gold"${state.loading || !proxyReady ? " disabled" : ""}>${state.loading ? "Loading…" : "Load stats"}</button></div></form>
    <button class="link" data-act="matcherino-example">Use example match</button></section>`;
  if (!proxyReady) return form + `<p class="empty">Matcherino stats will be available when the stats service is connected.</p>`;
  if (state.loading) return form + `<p role="status" class="empty">Loading Matcherino match reports…</p>`;
  if (state.error) return form + `<p role="alert" class="mt-error">${esc(state.error)}</p>`;
  const match = state.data;
  if (!match) return form + `<p class="empty">Choose a match to view its stats. Some matches have only scores; detailed stats appear when Matcherino recorded them.</p>`;
  return form + `<div class="mt-matchhead"><div><h2>${esc(match.teams[0].name)} <span>${number(match.teams[0].score)} – ${number(match.teams[1].score)}</span> ${esc(match.teams[1].name)}</h2><p class="hint">Tournament ${esc(match.tournamentId)} · Round ${esc(match.round)} · ${esc(match.status)}</p></div>
    <a class="btn btn-ghost" href="${esc(match.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open on Matcherino ↗</a></div>
    ${match.sets.length ? match.sets.map(s => setView(s, match)).join("") : `<p class="empty">No game reports have been posted for this match yet.</p>`}
    <p class="hint">Data from public Matcherino match reports. Map images from <a href="https://brawlify.com" target="_blank" rel="noopener noreferrer">Brawlify</a>.</p>`;
}
