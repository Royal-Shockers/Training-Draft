// Cloudflare Worker: holds the Brawl Stars API key and forwards read-only lookups.
// The key never reaches the browser, and Supercell only ever sees RoyaleAPI's fixed IP.
// Setup steps are in worker/README.md.

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
    if (!env.BRAWL_API_KEY) {
      return json({ error: "This worker has no API key saved yet (add the BRAWL_API_KEY secret)." }, 500, head);
    }

    const [, kind, rawTag] = new URL(request.url).pathname.split("/");
    const build = paths[kind];
    if (!build) return json({ error: "Unknown path. Use /player/TAG or /battlelog/TAG." }, 404, head);
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

    const res = new Response(await upstream.text(), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${TTL}` },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
    return withHeaders(res, head);
  },
};
