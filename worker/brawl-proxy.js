// Cloudflare Worker: holds the Brawl Stars API key and forwards read-only lookups.
// The key never reaches the browser, and Supercell only ever sees RoyaleAPI's fixed IP.
// Setup steps are in worker/README.md.

// Ranked tiers are numbered from Bronze I = 1, so Mythic I is the 13th step
// (Bronze/Silver/Gold/Diamond are 3 steps each). Only these players join the ladder.
const MYTHIC_I = 13;

const API = "https://bsproxy.royaleapi.dev/v1";
const TAG = /^[0289PYLQGRJCUV]{3,14}$/; // the only characters Supercell uses in tags
const TTL = 60; // seconds a reply is reused for, so the key's rate limit lasts

const paths = {
  player: tag => `/players/%23${tag}`,
  battlelog: tag => `/players/%23${tag}/battlelog`,
};

const upstreamMessage = status => ({
  400: "The Brawl Stars API rejected that tag.",
  403: "The API key was refused. Check it is still valid and whitelisted to 45.79.218.79.",
  404: "No player has that tag.",
  429: "Too many lookups for now — wait a minute and try again.",
  500: "The Brawl Stars API had an error.",
  503: "The Brawl Stars API is in maintenance (this happens during updates).",
}[status] || `The Brawl Stars API replied ${status}.`);

function cors(origin, allowed) {
  const h = { "Vary": "Origin", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" };
  // No ALLOWED_ORIGINS set: open to anyone. With a list set: only those sites.
  if (!allowed.length) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

// Every profile looked up on the site is remembered here, so the ladder grows as
// people search themselves. Failures are swallowed: a lookup must never break
// because the database is busy or missing.
async function remember(db, p) {
  if (!db || !p || typeof p.rankedRank !== "number" || p.rankedRank < MYTHIC_I) return;
  try {
    await db.prepare(
      `INSERT INTO players (tag, name, elo, rank, rank_name, best_elo, best_rank_name, club, trophies, season, updated)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(tag) DO UPDATE SET
         name=?2, elo=?3, rank=?4, rank_name=?5, best_elo=?6, best_rank_name=?7,
         club=?8, trophies=?9, season=?10, updated=?11`
    ).bind(
      String(p.tag || "").replace(/^#/, ""), p.name || "",
      p.rankedElo || 0, p.rankedRank, p.rankedRankName || "",
      p.highestSeasonRankedElo || null, p.highestSeasonRankedRankName || null,
      (p.club && p.club.name) || null, p.trophies || 0,
      p.rankedSeasonId || 0, Date.now()
    ).run();
  } catch { /* the ladder is a nicety; never fail a lookup over it */ }
}

// The ladder only shows the current season, since Elo resets when a season turns.
async function ladder(db, limit, offset) {
  const season = (await db.prepare(`SELECT MAX(season) AS s FROM players`).first()) || {};
  const where = `WHERE season = ?1`;
  const [rows, totals, tiers] = await Promise.all([
    db.prepare(`SELECT tag, name, elo, rank, rank_name, best_elo, club, trophies, updated
                FROM players ${where} ORDER BY elo DESC, rank DESC, name ASC LIMIT ?2 OFFSET ?3`)
      .bind(season.s || 0, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) AS n, MAX(updated) AS last FROM players ${where}`).bind(season.s || 0).first(),
    db.prepare(`SELECT rank_name, rank, COUNT(*) AS n FROM players ${where}
                GROUP BY rank_name, rank ORDER BY rank DESC`).bind(season.s || 0).all(),
  ]);
  return {
    season: season.s || 0,
    total: (totals && totals.n) || 0,
    updated: (totals && totals.last) || 0,
    players: (rows && rows.results) || [],
    tiers: (tiers && tiers.results) || [],
  };
}

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const head = cors(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: head });
    if (request.method !== "GET") return json({ error: "Only GET lookups are supported." }, 405, head);
    if (allowed.length && origin && !allowed.includes(origin)) {
      return json({ error: "This worker isn't shared with that website." }, 403, head);
    }
    const url = new URL(request.url);
    const [, kind, rawTag] = url.pathname.split("/");

    // The ladder is read straight from storage, so it needs no API key.
    if (kind === "leaderboard") {
      if (!env.DB) return json({ error: "This worker has no ladder database attached yet." }, 503, head);
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 100));
      const offset = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);
      try {
        return json(await ladder(env.DB, limit, offset), 200, head);
      } catch (e) {
        return json({ error: "Couldn't read the ladder. Has the players table been created?" }, 500, head);
      }
    }

    if (!env.BRAWL_API_KEY) {
      return json({ error: "This worker has no API key saved yet (add the BRAWL_API_KEY secret)." }, 500, head);
    }
    const build = paths[kind];
    if (!build) return json({ error: "Unknown path. Use /player/TAG, /battlelog/TAG or /leaderboard." }, 404, head);
    // People type O for zero; no tag contains the letter O, so swapping it is safe.
    const tag = decodeURIComponent(rawTag || "").replace(/^#/, "").toUpperCase().replace(/O/g, "0");
    if (!TAG.test(tag)) return json({ error: "That isn't a valid player tag." }, 400, head);

    const cache = caches.default;
    const key = new Request(`https://brawl-proxy.invalid/${kind}/${tag}`);
    const hit = await cache.match(key);
    if (hit) return withHeaders(hit, { ...head, "X-Proxy-Cache": "hit" });

    let upstream;
    try {
      upstream = await fetch(API + build(tag), {
        headers: { Authorization: `Bearer ${env.BRAWL_API_KEY}`, Accept: "application/json" },
      });
    } catch {
      return json({ error: "Couldn't reach the Brawl Stars API." }, 502, head);
    }
    if (!upstream.ok) {
      return json({ error: upstreamMessage(upstream.status), upstreamStatus: upstream.status }, upstream.status, head);
    }

    const body = await upstream.text();
    if (kind === "player" && env.DB) {
      try { ctx.waitUntil(remember(env.DB, JSON.parse(body))); } catch { /* unparseable: skip the ladder */ }
    }
    const res = new Response(body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${TTL}` },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
    return withHeaders(res, head);
  },
};
