// Latency measurement from the browser.
//
// A browser can't send ICMP, so there is no such thing as a real ping here. What it
// can do is time an HTTPS request and take the round trip. The first request to a
// host pays for DNS and the TLS handshake, so it is thrown away, and the best of the
// remaining samples is kept — the lowest is the one least polluted by other traffic.
//
// mode: "no-cors" matters: the reply is opaque and unreadable, but the request is
// still timed, which means any host works without needing CORS headers on it.

const TIMEOUT = 6000;

export async function once(url, timeout = TIMEOUT) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeout);
  const bust = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const start = performance.now();
  try {
    await fetch(bust, { mode: "no-cors", cache: "no-store", signal: stop.signal, credentials: "omit" });
    return performance.now() - start;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function measure(url, samples = 3) {
  if (!url) return null;
  await once(url);                       // warm-up, discarded
  const runs = [];
  for (let i = 0; i < samples; i++) {
    const ms = await once(url);
    if (ms != null) runs.push(ms);
  }
  return runs.length ? Math.round(Math.min(...runs)) : null;
}

// Walks the list one at a time, reporting each result as it lands. Measuring in
// parallel would have the requests competing for the same connection and inflate
// every number, so this stays sequential and just shows progress instead.
export async function measureAll(targets, onResult, shouldStop = () => false) {
  for (const t of targets) {
    if (shouldStop()) return;
    const ms = await measure(t.url);
    if (shouldStop()) return;
    onResult(t.key, ms);
  }
}
