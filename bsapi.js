// Talks to the Cloudflare Worker from worker/README.md. The worker holds the API key;
// nothing secret is in here.
import { PROXY_URL } from "./config.js";

const base = PROXY_URL.replace(/\/+$/, "");
export const PROXY_READY = /^https?:\/\/\S+/.test(base);

// No tag contains the letter O, so people typing O for zero is safe to fix.
export const normTag = s => String(s || "").trim().replace(/^#/, "").toUpperCase().replace(/O/g, "0");
export const validTag = t => /^[0289PYLQGRJCUV]{3,14}$/.test(t);

const TTL = 60000;
const cache = new Map(); // path -> { at, data }, so switching subtabs doesn't re-fetch

async function get(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let res;
  try {
    res = await fetch(`${base}/${path}`, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Couldn't reach the stats worker. Check your internet connection.");
  }
  let body = null;
  try { body = await res.json(); } catch { /* keep null and fall through */ }
  if (!res.ok) throw new Error((body && body.error) || `The stats worker replied ${res.status}.`);
  if (!body) throw new Error("The stats worker sent something unreadable.");
  cache.set(path, { at: Date.now(), data: body });
  return body;
}

export const fetchPlayer = tag => get(`player/${tag}`);
export const fetchBattles = tag => get(`battlelog/${tag}`).then(b => (b && b.items) || []);

export function forget(tag) {
  cache.delete(`player/${tag}`);
  cache.delete(`battlelog/${tag}`);
}
