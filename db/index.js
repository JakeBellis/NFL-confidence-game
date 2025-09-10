import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

sqlite3.verbose();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'data.db');
const schemaPath = path.join(__dirname, 'schema.sql');

export const db = new sqlite3.Database(dbPath);

const schemaSql = fs.readFileSync(schemaPath, 'utf8');
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.exec(schemaSql);
});

// Promise wrappers
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err); else resolve(this);
  });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

export const runInTransaction = async (fn) => {
  await run('BEGIN');
  try {
    const result = await fn();
    await run('COMMIT');
    return result;
  } catch (e) {
    try { await run('ROLLBACK'); } catch {}
    throw e;
  }
};

// Teams
export async function upsertTeam(t) {
  const sql = `
    INSERT INTO teams (espn_id, name, abbreviation, logo)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(espn_id) DO UPDATE SET
      name=excluded.name,
      abbreviation=excluded.abbreviation,
      logo=excluded.logo
  `;
  await run(sql, [t.espn_id, t.name, t.abbreviation, t.logo ?? null]);
}

// Games
export async function upsertGame(g) {
  const sql = `
    INSERT INTO games (event_id, season, week, start_utc, status, home_team_id, away_team_id, home_score, away_score, winner_team_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      start_utc=excluded.start_utc,
      status=excluded.status,
      home_team_id=excluded.home_team_id,
      away_team_id=excluded.away_team_id,
      home_score=excluded.home_score,
      away_score=excluded.away_score,
      winner_team_id=excluded.winner_team_id
  `;
  await run(sql, [
    g.event_id, g.season, g.week, g.start_utc, g.status,
    g.home_team_id, g.away_team_id, g.home_score ?? 0, g.away_score ?? 0,
    g.winner_team_id ?? null
  ]);
}

export function getGamesByWeek(season, week) {
  const sql = `
    SELECT g.*, th.name AS home_name, th.abbreviation AS home_abbr, th.logo AS home_logo,
           ta.name AS away_name, ta.abbreviation AS away_abbr, ta.logo AS away_logo
    FROM games g
    JOIN teams th ON th.espn_id = g.home_team_id
    JOIN teams ta ON ta.espn_id = g.away_team_id
    WHERE g.season=? AND g.week=?
    ORDER BY datetime(g.start_utc) ASC, g.event_id
  `;
  return all(sql, [season, week]);
}

// Picks
export async function upsertPick(p) {
  const sql = `
    INSERT INTO picks (user, season, week, event_id, picked_team_id, confidence)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user, event_id) DO UPDATE SET
      picked_team_id=excluded.picked_team_id,
      confidence=excluded.confidence
  `;
  await run(sql, [p.user, p.season, p.week, p.event_id, p.picked_team_id, p.confidence]);
}

export function getUserPicksByWeek(user, season, week) {
  return all(`SELECT * FROM picks WHERE user=? AND season=? AND week=?`, [user, season, week]);
}

export function getAllPicksByWeek(season, week) {
  return all(`SELECT * FROM picks WHERE season=? AND week=?`, [season, week]);
}

// Week fetch metadata
export async function upsertWeekFetch({ season, week, last_schedule_fetch_utc = null, last_results_fetch_utc = null }) {
  const sql = `
    INSERT INTO week_fetch (season, week, last_schedule_fetch_utc, last_results_fetch_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(season, week) DO UPDATE SET
      last_schedule_fetch_utc=COALESCE(excluded.last_schedule_fetch_utc, last_schedule_fetch_utc),
      last_results_fetch_utc=COALESCE(excluded.last_results_fetch_utc, last_results_fetch_utc)
  `;
  await run(sql, [season, week, last_schedule_fetch_utc, last_results_fetch_utc]);
}

export function getWeekFetch(season, week) {
  return get(`SELECT * FROM week_fetch WHERE season=? AND week=?`, [season, week]);
}

export function getWinnersByWeek(season, week) {
  return all(`SELECT event_id, winner_team_id FROM games WHERE season=? AND week=?`, [season, week]);
}

export function getSeasonTotals(season) {
  const sql = `
    SELECT p.user, SUM(p.confidence) AS total
    FROM picks p
    JOIN games g ON g.event_id = p.event_id AND g.season = p.season
    WHERE p.season = ?
      AND g.status = 'post'
      AND (
        (g.home_team_id = p.picked_team_id AND g.home_score > g.away_score) OR
        (g.away_team_id = p.picked_team_id AND g.away_score > g.home_score)
      )
    GROUP BY p.user
  `;
  return all(sql, [season]);
}
