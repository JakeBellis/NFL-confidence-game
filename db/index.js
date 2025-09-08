import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data.db');
const schemaPath = path.join(__dirname, 'schema.sql');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const schemaSql = fs.readFileSync(schemaPath, 'utf8');
db.exec(schemaSql);

// Teams
export const upsertTeam = db.prepare(`
  INSERT INTO teams (espn_id, name, abbreviation, logo)
  VALUES (@espn_id, @name, @abbreviation, @logo)
  ON CONFLICT(espn_id) DO UPDATE SET
    name=excluded.name,
    abbreviation=excluded.abbreviation,
    logo=excluded.logo
`);

// Games
export const upsertGame = db.prepare(`
  INSERT INTO games (event_id, season, week, start_utc, status, home_team_id, away_team_id, home_score, away_score, winner_team_id)
  VALUES (@event_id, @season, @week, @start_utc, @status, @home_team_id, @away_team_id, @home_score, @away_score, @winner_team_id)
  ON CONFLICT(event_id) DO UPDATE SET
    start_utc=excluded.start_utc,
    status=excluded.status,
    home_team_id=excluded.home_team_id,
    away_team_id=excluded.away_team_id,
    home_score=excluded.home_score,
    away_score=excluded.away_score,
    winner_team_id=excluded.winner_team_id
`);

export const getGamesByWeek = db.prepare(`
  SELECT g.*, th.name AS home_name, th.abbreviation AS home_abbr, th.logo AS home_logo,
         ta.name AS away_name, ta.abbreviation AS away_abbr, ta.logo AS away_logo
  FROM games g
  JOIN teams th ON th.espn_id = g.home_team_id
  JOIN teams ta ON ta.espn_id = g.away_team_id
  WHERE g.season=? AND g.week=?
  ORDER BY datetime(g.start_utc) ASC, g.event_id
`);

// Picks
export const upsertPick = db.prepare(`
  INSERT INTO picks (user, season, week, event_id, picked_team_id, confidence)
  VALUES (@user, @season, @week, @event_id, @picked_team_id, @confidence)
  ON CONFLICT(user, event_id) DO UPDATE SET
    picked_team_id=excluded.picked_team_id,
    confidence=excluded.confidence
`);

export const getUserPicksByWeek = db.prepare(`
  SELECT * FROM picks WHERE user=? AND season=? AND week=?
`);

export const getAllPicksByWeek = db.prepare(`
  SELECT * FROM picks WHERE season=? AND week=?
`);

// Week fetch metadata
export const upsertWeekFetch = db.prepare(`
  INSERT INTO week_fetch (season, week, last_schedule_fetch_utc, last_results_fetch_utc)
  VALUES (@season, @week, @last_schedule_fetch_utc, @last_results_fetch_utc)
  ON CONFLICT(season, week) DO UPDATE SET
    last_schedule_fetch_utc=COALESCE(excluded.last_schedule_fetch_utc, last_schedule_fetch_utc),
    last_results_fetch_utc=COALESCE(excluded.last_results_fetch_utc, last_results_fetch_utc)
`);

export const getWeekFetch = db.prepare(`
  SELECT * FROM week_fetch WHERE season=? AND week=?
`);

export { db };
