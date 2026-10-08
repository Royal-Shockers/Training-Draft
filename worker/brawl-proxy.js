// Cloudflare Worker: holds the Brawl Stars API key and forwards read-only lookups.
// The key never reaches the browser, and Supercell only ever sees RoyaleAPI's fixed IP.
// Setup steps are in worker/README.md.

// Ranked tiers are numbered from Bronze I = 1 (Bronze/Silver/Gold/Diamond/Mythic/
// Legendary are 3 steps each, then Masters I-III, then Pro). Masters II is 20.
const MIN_RANK = 20;

// Seeds for the crawler. Supercell has no "list every ranked player" endpoint, so the
// only way to find players is the trophy rankings: the top 200 of each country.
const COUNTRIES = ("global ad ae af ag ai al am ao ar as at au aw az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw " +
  "by bz ca cd cf cg ch ci cl cm cn co cr cu cv cy cz de dj dk dm do dz ec ee eg er es et fi fj fm fr ga gb gd ge gh " +
  "gm gn gq gr gt gw gy hk hn hr ht hu id ie il in iq ir is it jm jo jp ke kg kh ki km kn kp kr kw kz la lb lc li lk " +
  "lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mr mt mu mv mw mx my mz na ne ng ni nl no np nr nz om pa pe pg " +
  "ph pk pl pr ps pt pw py qa ro rs ru rw sa sb sc sd se sg si sk sl sm sn so sr ss sv sy sz td tg th tj tl tm tn to " +
  "tr tt tv tw tz ua ug us uy uz va vc ve vn vu ws ye za zm zw").split(" ");

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
  if (!db || !p || typeof p.rankedRank !== "number" || p.rankedRank < MIN_RANK) return;
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

// Rows only change when someone looks that player up, so Elo goes stale. The cron
// trigger re-syncs the least recently seen players, oldest first, a batch at a time.
const REFRESH_BATCH = 20;   // kept small: each one is a subrequest, and the key has a rate limit
const REFRESH_LANES = 5;

// --- crawler -------------------------------------------------------------------
// One country's trophy top 200 per run goes into a queue; the queue is then drained
// by looking each tag up and keeping the ones at MIN_RANK or above.

const asInt = v => (typeof v === "number" ? v : parseInt(v, 10) || 0);

async function readState(db, key) {
  const r = await db.prepare(`SELECT v FROM crawl WHERE k = ?1`).bind(key).first();
  return r ? r.v : null;
}
const writeState = (db, key, value) => db.prepare(
  `INSERT INTO crawl (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2`).bind(key, String(value)).run();

// Pulls the next country's rankings and queues every tag it hasn't seen before.
async function seedNext(env) {
  const db = env.DB;
  const at = asInt(await readState(db, "country")) % COUNTRIES.length;
  const country = COUNTRIES[at];
  await writeState(db, "country", (at + 1) % COUNTRIES.length);

  let items = [];
  try {
    const res = await fetch(`${API}/rankings/${country}/players`, {
      headers: { Authorization: `Bearer ${env.BRAWL_API_KEY}`, Accept: "application/json" },
    });
    if (!res.ok) return { country, queued: 0 };
    items = (await res.json()).items || [];
  } catch { return { country, queued: 0 }; }

  const now = Date.now();
  const rows = items
    .map(i => String(i.tag || "").replace(/^#/, "").toUpperCase())
    .filter(t => TAG.test(t))
    // Already on the ladder or already queued: INSERT OR IGNORE sorts both out.
    .map(t => db.prepare(`INSERT OR IGNORE INTO queue (tag, added, checked) VALUES (?1, ?2, NULL)`).bind(t, now));
  if (rows.length) await db.batch(rows);
  return { country, offered: rows.length };   // duplicates are ignored, so this is an upper bound
}

// Looks up queued tags and keeps the ones that qualify.
async function drainQueue(env, budget) {
  const db = env.DB;
  if (budget < 1) return { checked: 0, kept: 0 };
  const { results = [] } = await db.prepare(
    `SELECT tag FROM queue WHERE checked IS NULL ORDER BY added ASC LIMIT ?1`).bind(budget).all();
  let kept = 0, checked = 0;

  for (let i = 0; i < results.length; i += REFRESH_LANES) {
    await Promise.all(results.slice(i, i + REFRESH_LANES).map(async ({ tag }) => {
      let p = null;
      try {
        const res = await fetch(API + paths.player(tag), {
          headers: { Authorization: `Bearer ${env.BRAWL_API_KEY}`, Accept: "application/json" },
        });
        // Leave a tag unchecked when the API is merely unavailable, so it is retried.
        if (res.status >= 500 || res.status === 429) return;
        if (res.ok) p = await res.json();
      } catch { return; }
      checked++;
      if (p && typeof p.rankedRank === "number" && p.rankedRank >= MIN_RANK) { await remember(db, p); kept++; }
      await db.prepare(`UPDATE queue SET checked = ?2 WHERE tag = ?1`).bind(tag, Date.now()).run();
    }));
  }
  return { checked, kept };
}

// A run seeds when the queue is running dry, drains it, and falls back to refreshing
// the ladder itself once there is nothing new left to look at.
async function crawl(env, budget = REFRESH_BATCH) {
  const db = env.DB;
  const pending = await db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE checked IS NULL`).first();
  let seeded = null, left = budget;
  if ((pending ? pending.n : 0) < budget * 2) { seeded = await seedNext(env); left -= 1; }
  const drained = await drainQueue(env, left);
  const idle = drained.checked === 0 && left > 0;
  const refreshed = idle ? await refreshStalest(env, left) : null;
  return { seeded, ...drained, refreshed };
}

async function refreshStalest(env, limit = REFRESH_BATCH) {
  const { results = [] } = await env.DB.prepare(
    `SELECT tag FROM players ORDER BY updated ASC LIMIT ?1`).bind(limit).all();
  const drop = tag => env.DB.prepare(`DELETE FROM players WHERE tag = ?1`).bind(tag).run();
  let refreshed = 0, dropped = 0, failed = 0;

  for (let i = 0; i < results.length; i += REFRESH_LANES) {
    await Promise.all(results.slice(i, i + REFRESH_LANES).map(async ({ tag }) => {
      let res;
      try {
        res = await fetch(API + paths.player(tag), {
          headers: { Authorization: `Bearer ${env.BRAWL_API_KEY}`, Accept: "application/json" },
        });
      } catch { failed++; return; }
      // A tag that no longer exists is gone for good; anything else may be temporary.
      if (res.status === 404) { await drop(tag); dropped++; return; }
      if (!res.ok) { failed++; return; }
      let p;
      try { p = await res.json(); } catch { failed++; return; }
      if (typeof p.rankedRank === "number" && p.rankedRank >= MIN_RANK) {
        await remember(env.DB, p);
        refreshed++;
      } else {
        await drop(tag);   // fell below Mythic I, so off the ladder
        dropped++;
      }
    }));
  }
  return { refreshed, dropped, failed, looked: results.length };
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
  // Wired to a cron trigger in the dashboard; see worker/README.md step 5.
  async scheduled(event, env, ctx) {
    if (!env.DB || !env.BRAWL_API_KEY) return;
    ctx.waitUntil(crawl(env).then(
      r => console.log("ladder crawl", JSON.stringify(r)),
      e => console.log("ladder crawl failed", e && e.message)
    ));
  },

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

    // Runs the same refresh the cron does. Only exists if a REFRESH_KEY secret is set,
    // so nobody can burn the API rate limit by hitting a public URL.
    if (kind === "refresh") {
      if (!env.REFRESH_KEY || url.searchParams.get("key") !== env.REFRESH_KEY) {
        return json({ error: "Unknown path. Use /player/TAG, /battlelog/TAG or /leaderboard." }, 404, head);
      }
      if (!env.DB) return json({ error: "This worker has no ladder database attached yet." }, 503, head);
      return json(await crawl(env), 200, head);
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
