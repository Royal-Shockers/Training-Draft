-- Ladder storage for the Ranked ladder section.
-- Run this once against your D1 database (see worker/README.md).
--
-- One row per player the site has ever looked up, at Mythic I or above. The row is
-- overwritten each time that player is looked up again, so it always holds their
-- latest tier and Elo rather than a history.

CREATE TABLE IF NOT EXISTS players (
  tag            TEXT PRIMARY KEY,   -- without the leading #
  name           TEXT NOT NULL,
  elo            INTEGER NOT NULL,   -- rankedElo: what the ladder sorts on
  rank           INTEGER NOT NULL,   -- rankedRank, 13 = Mythic I
  rank_name      TEXT NOT NULL,      -- e.g. LEGENDARY III
  best_elo       INTEGER,            -- highest this season
  best_rank_name TEXT,
  club           TEXT,
  trophies       INTEGER,
  season         INTEGER NOT NULL,   -- rankedSeasonId; Elo resets each season
  updated        INTEGER NOT NULL    -- ms since epoch, when we last saw them
);

-- The leaderboard reads one season ordered by Elo, so index that pair.
CREATE INDEX IF NOT EXISTS players_season_elo ON players (season, elo DESC);
