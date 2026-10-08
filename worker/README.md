# Live player stats: the API key holder

The Players tab reads live profiles from Supercell's Brawl Stars API. Two things stop the
website from calling that API by itself:

- **Keys are locked to one IP address.** Your site runs in each visitor's browser, and every
  visitor has a different IP.
- **This repo is public.** A key sitting in `config.js` would be copied and used by strangers,
  and Supercell would throttle or revoke it.

So the key lives in a tiny Cloudflare Worker instead. The website asks the worker, the worker
asks Supercell. It is free, needs no credit card, and the whole thing is the 80-line
`brawl-proxy.js` next to this file.

## 1. Get an API key

1. Sign in at <https://developer.brawlstars.com> with your Supercell ID.
2. **My Account → Create New Key.**
3. Name: anything. Description: anything.
4. **Allowed IP Addresses: `45.79.218.79`**

   That is [RoyaleAPI's proxy](https://docs.royaleapi.com/proxy.html) — a free service with one
   unchanging IP, built for exactly this problem. The worker calls Supercell through it, so
   Supercell only ever sees that one address and the key keeps working.
5. Copy the key. It is shown in full on the key's page any time, so it is fine to come back for it.

## 2. Put the worker on Cloudflare

No tools to install — this is all in the browser.

1. Sign up at <https://dash.cloudflare.com> (free plan).
2. **Compute (Workers) → Create → Start with Hello World! → Deploy.** Name it `brawl-proxy`.
3. **Edit code**, select everything in the editor, and paste in the contents of
   `brawl-proxy.js`. **Deploy**.
4. **Settings → Variables and Secrets → Add:**
   - Type **Secret**, name `BRAWL_API_KEY`, value = the key from step 1.
     A secret can't be read back out of the dashboard or printed by the worker.
   - Type **Text**, name `ALLOWED_ORIGINS`, value `https://royal-shockers.github.io`
     (comma-separate more sites if you ever add one; leave it off to allow any site).
5. **Deploy** again so the variables take effect.
6. Copy the worker's address, something like `https://brawl-proxy.yourname.workers.dev`.

Check it works by opening `https://brawl-proxy.yourname.workers.dev/player/Y2PLQQCGP` in a
tab — you should see a wall of JSON. An error there tells you which step to revisit.

## 3. Switch the tab on

In `config.js`, set:

```js
export const PROXY_URL = "https://brawl-proxy.yourname.workers.dev";
```

Commit and push. The Players tab appears on the site. The worker address is public on
purpose — it holds no secret, only forwards lookups, and answers nothing but public profile
data that anyone could read in the game.

## What the worker does and doesn't do

- Two routes: `/player/TAG` and `/battlelog/TAG`. Nothing else, and GET only.
- Rejects anything that isn't a real tag before spending a request.
- Caches each reply for 60 seconds, so a whole team refreshing shares one lookup.
- Never writes anything, and never touches your Firebase data.

## Limits worth knowing

- **The battle log is the last 25 games, and that's all there is.** Supercell keeps no more.
  Your own Matches tab is what gives the team long-term history; this tab is a live snapshot.
- **Rank tier, Elo, fame and prestige do come from the API** (`rankedRankName`, `rankedElo`,
  `fameTierName`, `totalPrestigeLevel`), along with each brawler's prestige, win streaks and
  hypercharge. Everything else — ranked win rates, per-map and per-brawler records, sessions,
  teammate and opponent records — is worked out here from the battle log.
- Supercell's API goes down during game updates. The tab says so when that happens.
