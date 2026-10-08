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

## 4. The ranked ladder database (optional)

The Ranked ladder section needs somewhere to remember players. Without it the rest
of the site works fine and the ladder says it isn't switched on.

1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create**.
   Name it `brawl-ladder`. Free tier, no card.
2. Open it → **Console** tab → paste in the contents of `schema.sql` → **Execute**.
3. Go back to your worker → **Settings → Bindings → Add → D1 database**.
   - Variable name: **`DB`** (exactly this — the worker looks for `env.DB`)
   - Database: `brawl-ladder`
4. **Deploy**.

Check it with `https://brawl-proxy.yourname.workers.dev/leaderboard` — you should get
`{"season":0,"total":0,...}` on an empty ladder, not an error.

How it fills: anyone looked up through the site is saved if they are **Masters II or
above**, and the cron job (step 5) crawls the game's own country rankings to find
players nobody has searched for. Each lookup overwrites that player's row, so the
table holds their latest tier and Elo, not a history.

## 5. Keep the ladder fresh (optional, needs step 4)

A player's row only changes when someone looks them up, so Elo drifts out of date.
A cron trigger re-syncs the least recently seen players automatically.

1. Your worker → **Settings → Triggers → Cron Triggers → Add**.
2. Schedule: `0 * * * *` (every hour, on the hour). **Add**, then **Deploy**.

Each run does up to 20 lookups: it takes one country's trophy top 200 into a queue,
then works through the queue, keeping everyone at Masters II or above. Once the
queue is empty it re-syncs the stalest players already on the ladder instead.

Supercell has no "list every ranked player" endpoint, so the country rankings are
the only way to find players nobody has searched for. That means the ladder covers
the top 200 by trophies in each country — a Masters II player outside their
country's trophy top 200 won't be found this way.

Hourly is slow for this: ~480 lookups a day against roughly 40,000 seed tags. Use
`*/5 * * * *` or `* * * * *` to fill it in days rather than months. At one run a
minute it is about 29,000 lookups a day, inside Cloudflare's free tier.

Per player: still Masters II or above → row updated; dropped below, or a tag that
no longer exists → removed from the ladder. A failing or unreachable API leaves
both the row and the queue entry alone, so an outage never empties the ladder.

**To test it without waiting for the hour**, add a **Secret** named `REFRESH_KEY`
with any value you choose, then open
`https://brawl-proxy.yourname.workers.dev/refresh?key=YOURVALUE`. It runs the same
job and reports what it did. Without that secret the route doesn't exist, so nobody
else can trigger it.

## What the worker does and doesn't do

- Three public routes: `/player/TAG`, `/battlelog/TAG` and `/leaderboard`, GET only.
  `/refresh` exists only when you set a `REFRESH_KEY` secret.
- Rejects anything that isn't a real tag before spending a request.
- Caches each reply for 60 seconds, so a whole team refreshing shares one lookup.
- Writes only to its own ladder database, and never touches your Firebase data.

## Limits worth knowing

- **The battle log is the last 25 games, and that's all there is.** Supercell keeps no more.
  Your own Matches tab is what gives the team long-term history; this tab is a live snapshot.
- **Rank tier, Elo, fame and prestige do come from the API** (`rankedRankName`, `rankedElo`,
  `fameTierName`, `totalPrestigeLevel`), along with each brawler's prestige, win streaks and
  hypercharge. Everything else — ranked win rates, per-map and per-brawler records, sessions,
  teammate and opponent records — is worked out here from the battle log.
- Supercell's API goes down during game updates. The tab says so when that happens.
