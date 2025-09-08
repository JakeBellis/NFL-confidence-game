import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { db, upsertTeam, upsertGame, getGamesByWeek, upsertPick as upsertPickDB, getUserPicksByWeek, getAllPicksByWeek, upsertWeekFetch, getWeekFetch } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Legacy JSON persistence removed in favor of SQLite

function getSeasonYear(date = new Date()) {
  // NFL regular season spans starting Sep week to Jan; use year of September if before March
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  if (month < 3) return year - 1; // Jan/Feb considered previous season year
  return year;
}

async function fetchWeekGames({ season, week }) {
  // ESPN scoreboard API (regular season seasontype=2)
  // Use 'year' parameter for season; 'dates' is for specific date filters.
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&year=${season}`;
  const { data } = await axios.get(url, { timeout: 20000 });
  const events = Array.isArray(data?.events) ? data.events : [];
  const games = events.map((ev) => {
    const comp = Array.isArray(ev.competitions) ? ev.competitions[0] : {};
    const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
    const home = competitors.find(c => c.homeAway === 'home') || {};
    const away = competitors.find(c => c.homeAway === 'away') || {};
    const homeTeam = home.team || {};
    const awayTeam = away.team || {};
    const pickLogo = (team) => team.logo || team.logos?.[0]?.href || '';
    return {
      id: ev.id,
      date: ev.date,
      status: comp?.status?.type?.name || ev?.status?.type?.name || 'STATUS_SCHEDULED',
      home: {
        id: home?.id,
        name: homeTeam.shortDisplayName || homeTeam.displayName || homeTeam.name,
        abbreviation: homeTeam.abbreviation,
        logo: pickLogo(homeTeam),
        score: home?.score != null ? Number(home.score) : null,
      },
      away: {
        id: away?.id,
        name: awayTeam.shortDisplayName || awayTeam.displayName || awayTeam.name,
        abbreviation: awayTeam.abbreviation,
        logo: pickLogo(awayTeam),
        score: away?.score != null ? Number(away.score) : null,
      }
    };
  });
  return games;
}

function determineWinner(game) {
  if (game.home.score == null || game.away.score == null) return null;
  if (game.home.score > game.away.score) return 'home';
  if (game.away.score > game.home.score) return 'away';
  return 'tie';
}

function currentWeekFromScoreboard(scoreboard) {
  // ESPN includes week info; fall back to param
  return scoreboard?.week?.number || null;
}

app.get('/api/week-info', async (req, res) => {
  try {
    const season = getSeasonYear();
    const guessWeeks = Array.from({ length: 18 }, (_, i) => i + 1);
    // Try to detect the current week by finding a scoreboard that has events close to now
    // For simplicity, return season and let client choose week
    res.json({ season, defaultWeek: null, weeks: guessWeeks });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get week info' });
  }
});

app.get('/api/games', async (req, res) => {
  try {
    const season = Number(req.query.season) || getSeasonYear();
    const week = Number(req.query.week);
    if (!week) return res.status(400).json({ error: 'week is required' });

    // Try DB first
    let rows = getGamesByWeek.all(season, week);
    if (!rows.length) {
      const games = await fetchWeekGames({ season, week });
      // Upsert teams and games into DB
      for (const g of games) {
        const mapTeam = (t) => ({
          espn_id: t.id,
          name: t.name,
          abbreviation: t.abbreviation,
          logo: t.logo || null,
        });
        upsertTeam.run(mapTeam(g.home));
        upsertTeam.run(mapTeam(g.away));
        const status = (g.status || '').toLowerCase().includes('final') ? 'post' : 'pre';
        upsertGame.run({
          event_id: g.id,
          season,
          week,
          start_utc: g.date,
          status,
          home_team_id: g.home.id,
          away_team_id: g.away.id,
          home_score: g.home.score ?? 0,
          away_score: g.away.score ?? 0,
          winner_team_id: null
        });
      }
      upsertWeekFetch.run({ season, week, last_schedule_fetch_utc: new Date().toISOString(), last_results_fetch_utc: null });
      rows = getGamesByWeek.all(season, week);
    }
    // Map DB rows to existing client shape
    const payload = rows.map(r => ({
      id: r.event_id,
      date: r.start_utc,
      status: r.status === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED',
      home: { id: r.home_team_id, name: r.home_name, abbreviation: r.home_abbr, logo: r.home_logo, score: r.home_score },
      away: { id: r.away_team_id, name: r.away_name, abbreviation: r.away_abbr, logo: r.away_logo, score: r.away_score },
    }));
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

app.post('/api/picks', (req, res) => {
  try {
    const { user, season, week, picks } = req.body;
    if (!user || !season || !week || !Array.isArray(picks)) {
      return res.status(400).json({ error: 'user, season, week, picks required' });
    }

    // picks: [ { gameId, pick: 'home'|'away', confidence: number } ]
    const confidences = picks.map(p => p.confidence);
    const unique = new Set(confidences);
    if (confidences.length !== unique.size) {
      return res.status(400).json({ error: 'Each confidence value must be unique' });
    }

    // translate pick side -> team id using DB
    const rows = getGamesByWeek.all(season, week);
    const byId = new Map(rows.map(r => [r.event_id, r]));
    db.transaction((ps) => {
      for (const p of ps) {
        const r = byId.get(p.gameId);
        if (!r) continue;
        const teamId = p.pick === 'home' ? r.home_team_id : r.away_team_id;
        upsertPickDB.run({ user, season, week, event_id: p.gameId, picked_team_id: teamId, confidence: p.confidence });
      }
    })(picks);
    res.json({ ok: true });
  } catch (e) {
    const msg = String(e);
    if (msg.includes('uniq_picks_user_week_conf')) {
      return res.status(400).json({ error: 'Each confidence value must be unique' });
    }
    res.status(500).json({ error: 'Failed to save picks' });
  }
});

app.get('/api/picks', (req, res) => {
  const { user, season, week } = req.query;
  if (!user) return res.json([]);
  const rows = getUserPicksByWeek.all(user, Number(season), Number(week));
  // convert to old shape for UI
  const games = getGamesByWeek.all(Number(season), Number(week));
  const byId = new Map(games.map(r => [r.event_id, r]));
  const payload = rows.map(r => {
    const g = byId.get(r.event_id);
    const pick = g && r.picked_team_id === g.home_team_id ? 'home' : 'away';
    return { gameId: r.event_id, pick, confidence: r.confidence };
  });
  res.json(payload);
});

app.get('/api/scoreboard', (req, res) => {
  const { season, week } = req.query;
  if (!season || !week) return res.status(400).json({ error: 'season and week required' });
  const s = Number(season), w = Number(week);
  const picks = getAllPicksByWeek.all(s, w);
  const rows = db.prepare(`SELECT event_id, winner_team_id FROM games WHERE season=? AND week=?`).all(s, w);
  const winners = new Map(rows.map(r => [r.event_id, r.winner_team_id]));
  const totals = {};
  for (const p of picks) {
    const winTeam = winners.get(p.event_id);
    if (!winTeam) continue;
    if (!totals[p.user]) totals[p.user] = 0;
    if (winTeam === p.picked_team_id) totals[p.user] += p.confidence;
  }
  res.json({ scores: totals, results: Object.fromEntries(winners) });
});

async function updateResults(season, week) {
  try {
    const games = await fetchWeekGames({ season, week });
    const results = {};
    for (const g of games) {
      const final = (g.status || '').toUpperCase().includes('FINAL');
      const homeScore = Number(g.home.score ?? 0);
      const awayScore = Number(g.away.score ?? 0);
      const winnerTeamId = final ? (homeScore === awayScore ? null : (homeScore > awayScore ? g.home.id : g.away.id)) : null;
      upsertGame.run({
        event_id: g.id,
        season,
        week,
        start_utc: g.date,
        status: final ? 'post' : 'in',
        home_team_id: g.home.id,
        away_team_id: g.away.id,
        home_score: homeScore,
        away_score: awayScore,
        winner_team_id: winnerTeamId
      });
      if (final && winnerTeamId) results[g.id] = winnerTeamId === g.home.id ? 'home' : 'away';
    }
    upsertWeekFetch.run({ season, week, last_schedule_fetch_utc: null, last_results_fetch_utc: new Date().toISOString() });
    return results;
  } catch (e) {
    console.error('updateResults failed', e.message);
    return null;
  }
}

app.post('/api/update-results', async (req, res) => {
  const { season, week } = req.body;
  if (!season || !week) return res.status(400).json({ error: 'season and week required' });
  const results = await updateResults(Number(season), Number(week));
  if (!results) return res.status(500).json({ error: 'Failed to update results' });
  res.json({ ok: true, results });
});

// Cron: run every hour to update current season weeks 1..18
cron.schedule('15 * * * *', async () => {
  const season = getSeasonYear();
  for (let week = 1; week <= 18; week++) {
    await updateResults(season, week);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
