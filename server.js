import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// JSON persistence using db.json
const DB_PATH = path.join(__dirname, 'db.json');

function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Ensure basic structure
    return Object.assign({ users: [], picks: {}, results: {}, gamesCache: {} }, data);
  } catch (e) {
    const init = { users: [], picks: {}, results: {}, gamesCache: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

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
    let defaultWeek = null;
    try {
      // Ask ESPN for the current week's scoreboard for this season
      const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&year=${season}`;
      const { data } = await axios.get(url, { timeout: 20000 });
      const wk = data?.week?.number;
      if (Number.isInteger(wk) && wk >= 1 && wk <= 18) defaultWeek = wk;
    } catch (_) {
      // ignore and fall back to null
    }
    res.json({ season, defaultWeek, weeks: guessWeeks });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get week info' });
  }
});

app.get('/api/games', async (req, res) => {
  try {
    const season = Number(req.query.season) || getSeasonYear();
    const week = Number(req.query.week);
    if (!week) return res.status(400).json({ error: 'week is required' });

    const key = `${season}-${week}`;
    const db = readDB();
    let cache = db.gamesCache?.[key];
    if (!cache || !Array.isArray(cache.games) || cache.games.length === 0) {
      const games = await fetchWeekGames({ season, week });
      db.gamesCache = db.gamesCache || {};
      db.gamesCache[key] = { ts: Date.now(), games };
      writeDB(db);
      cache = db.gamesCache[key];
    }
    res.json(cache.games || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

app.post('/api/picks', async (req, res) => {
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

    const db = readDB();
    const key = `${season}-${week}`;
    if (!db.picks) db.picks = {};
    if (!db.picks[key]) db.picks[key] = {};
    db.picks[key][user] = picks;
    writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save picks' });
  }
});

app.get('/api/picks', async (req, res) => {
  const { user, season, week } = req.query;
  if (!user) return res.json([]);
  const db = readDB();
  const key = `${season}-${week}`;
  const payload = db.picks?.[key]?.[user] || [];
  res.json(payload);
});

app.get('/api/scoreboard', async (req, res) => {
  const { season, week } = req.query;
  if (!season || !week) return res.status(400).json({ error: 'season and week required' });
  const key = `${season}-${week}`;
  const db = readDB();
  const results = db.results?.[key] || {};
  const weekPicks = db.picks?.[key] || {};
  const totals = {};
  for (const [user, arr] of Object.entries(weekPicks)) {
    totals[user] = 0;
    for (const p of arr) {
      if (results[p.gameId] && results[p.gameId] === p.pick) {
        totals[user] += Number(p.confidence) || 0;
      }
    }
  }
  res.json({ scores: totals, results });
});

// Season-long cumulative scoreboard
app.get('/api/scoreboard-season', async (req, res) => {
  const { season } = req.query;
  if (!season) return res.status(400).json({ error: 'season required' });
  const s = String(season);
  const db = readDB();
  const totals = {};
  for (const [key, users] of Object.entries(db.picks || {})) {
    if (!key.startsWith(`${s}-`)) continue;
    const weekResults = db.results?.[key] || {};
    for (const [user, arr] of Object.entries(users)) {
      if (!totals[user]) totals[user] = 0;
      for (const p of arr) {
        if (weekResults[p.gameId] && weekResults[p.gameId] === p.pick) {
          totals[user] += Number(p.confidence) || 0;
        }
      }
    }
  }
  res.json({ scores: totals });
});

async function updateResults(season, week) {
  try {
    const games = await fetchWeekGames({ season, week });
    const db = readDB();
    const key = `${season}-${week}`;
    // Update cache with latest scores/statuses
    db.gamesCache = db.gamesCache || {};
    db.gamesCache[key] = { ts: Date.now(), games };

    // Compute results for finals
    db.results = db.results || {};
    const weekResults = db.results[key] || {};
    for (const g of games) {
      const final = (g.status || '').toUpperCase().includes('FINAL');
      if (final) {
        if (g.home.score == null || g.away.score == null) continue;
        if (g.home.score === g.away.score) continue; // ignore ties
        weekResults[g.id] = g.home.score > g.away.score ? 'home' : 'away';
      }
    }
    db.results[key] = weekResults;
    writeDB(db);
    return weekResults;
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
cron.schedule('0 0 * * *', async () => {
  const season = getSeasonYear();
  for (let week = 1; week <= 18; week++) {
    await updateResults(season, week);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
