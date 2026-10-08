// Latency measurement from the browser.
//
// A browser can't send ICMP, so this times an HTTPS round trip to a machine in the
// same datacentre as the game server instead. Getting that close to a real ping
// takes some care, because a naive fetch() measures far more than the network:
//
//  - The first request to a host pays for DNS, the TCP handshake and the TLS
//    handshake — three or more round trips. Two warm-up requests are thrown away so
//    the rest run over an established connection.
//  - These endpoints are Cloud Run services that can be cold, which adds hundreds of
//    milliseconds to whichever request wakes them. That is what the warm-ups absorb,
//    and why the best sample is kept rather than the average.
//  - Wall-clock timing around fetch() still includes the browser's own queueing. The
//    Resource Timing entry has the actual network numbers, so responseStart minus
//    requestStart is used when the server allows reading it: that is one round trip
//    plus the server's handling, and nothing else.
//
// mode "no-cors" keeps this working on any host: the reply is unreadable, but the
// request is still timed.

const TIMEOUT = 6000;
const WARMUPS = 2;
const SAMPLES = 4;

export async function once(url, timeout = TIMEOUT) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeout);
  const bust = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const start = performance.now();
  try {
    await fetch(bust, { mode: "no-cors", cache: "no-store", signal: stop.signal, credentials: "omit" });
    const wall = performance.now() - start;
    const entry = performance.getEntriesByName(bust).pop();
    if (entry && entry.requestStart > 0 && entry.responseStart > entry.requestStart) {
      return entry.responseStart - entry.requestStart;
    }
    return wall;   // cross-origin without Timing-Allow-Origin: wall clock is all there is
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function measure(url, samples = SAMPLES) {
  if (!url) return null;
  for (let i = 0; i < WARMUPS; i++) await once(url);
  const runs = [];
  for (let i = 0; i < samples; i++) {
    const ms = await once(url);
    if (ms != null) runs.push(ms);
  }
  // The buffer fills up fast at four entries per server, and it is of no use once read.
  if (performance.clearResourceTimings) performance.clearResourceTimings();
  return runs.length ? Math.round(Math.min(...runs)) : null;
}

// Walks the list one at a time, reporting each result as it lands. Measuring in
// parallel would have the requests competing for bandwidth and inflate every number,
// so this stays sequential and shows progress instead.
export async function measureAll(targets, onResult, shouldStop = () => false) {
  for (const t of targets) {
    if (shouldStop()) return;
    const ms = await measure(t.url);
    if (shouldStop()) return;
    onResult(t.key, ms);
  }
}
