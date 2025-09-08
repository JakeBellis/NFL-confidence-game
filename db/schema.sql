-- Teams
CREATE TABLE IF NOT EXISTS teams (
  espn_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  abbreviation TEXT NOT NULL,
  logo TEXT
);

-- Games (ESPN event id as primary key)
CREATE TABLE IF NOT EXISTS games (
  event_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  status TEXT NOT NULL, -- pre | in | post
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_score INTEGER DEFAULT 0,
  away_score INTEGER DEFAULT 0,
  winner_team_id TEXT,
  CHECK (status IN ('pre','in','post')),
  FOREIGN KEY (home_team_id) REFERENCES teams(espn_id),
  FOREIGN KEY (away_team_id) REFERENCES teams(espn_id)
);

CREATE INDEX IF NOT EXISTS idx_games_season_week ON games(season, week);

-- Picks
CREATE TABLE IF NOT EXISTS picks (
  user TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  picked_team_id TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  PRIMARY KEY (user, event_id),
  FOREIGN KEY (event_id) REFERENCES games(event_id)
);

-- Enforce unique confidence per user/week
CREATE UNIQUE INDEX IF NOT EXISTS uniq_picks_user_week_conf
  ON picks(user, season, week, confidence);

-- Fetch metadata per week (throttling of ESPN calls)
CREATE TABLE IF NOT EXISTS week_fetch (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  last_schedule_fetch_utc TEXT,
  last_results_fetch_utc TEXT,
  PRIMARY KEY (season, week)
);
