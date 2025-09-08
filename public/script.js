const userEl = document.getElementById('user');
const seasonEl = document.getElementById('season');
const weekEl = document.getElementById('week');
const loadBtn = document.getElementById('load');
const saveBtn = document.getElementById('save');
const gamesEl = document.getElementById('games');
const hintEl = document.getElementById('rangeHint');
const scoreboardEl = document.getElementById('scoreboard');
const refreshResultsBtn = document.getElementById('refreshResults');

let games = [];

function restorePrefs() {
  const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
  if (prefs.user) userEl.value = prefs.user;
  if (prefs.season) seasonEl.value = prefs.season;
  if (prefs.week) weekEl.value = prefs.week;
}
function savePrefs() {
  localStorage.setItem('prefs', JSON.stringify({
    user: userEl.value.trim(),
    season: Number(seasonEl.value),
    week: Number(weekEl.value),
  }));
}

async function fetchWeekInfo() {
  const res = await fetch('/api/week-info');
  const data = await res.json();
  if (!seasonEl.value) seasonEl.value = data.season;
}

function confidenceRangeForCount(n) {
  // Highest is 16; produce n values descending from 16 to (17 - n)
  const start = 16;
  const min = Math.max(1, 17 - n);
  const arr = [];
  for (let v = start; v >= min; v--) arr.push(v);
  return arr;
}

function renderGames() {
  gamesEl.innerHTML = '';
  const range = confidenceRangeForCount(games.length);
  hintEl.textContent = `Allowed numbers: ${range.join(', ')} (use each at most once)`;

  if (!games.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No games found for this week.';
    gamesEl.appendChild(empty);
    return;
  }

  for (const g of games) {
    const row = document.createElement('div');
    row.className = 'game';
    row.dataset.gameId = g.id;

    const home = document.createElement('div');
    home.className = 'team home';
    home.innerHTML = `<img src="${g.home.logo}" alt="${g.home.abbreviation}"><div><div>${g.home.name}</div><div class="status">Home</div></div>`;
    const homeInput = document.createElement('input');
    homeInput.type = 'number';
    homeInput.className = 'conf-input';
    homeInput.placeholder = '—';
    homeInput.min = String(Math.min(...range));
    homeInput.max = String(Math.max(...range));
    homeInput.dataset.side = 'home';
    homeInput.addEventListener('input', onConfidenceChange);
    // score badge near team logo
    const homeScore = document.createElement('span');
    homeScore.className = 'team-score';
    home.appendChild(homeScore);
    home.appendChild(homeInput);
    
    const away = document.createElement('div');
    away.className = 'team away';
    away.innerHTML = `<img src="${g.away.logo}" alt="${g.away.abbreviation}"><div><div>${g.away.name}</div><div class="status">Away</div></div>`;
    const awayInput = document.createElement('input');
    awayInput.type = 'number';
    awayInput.className = 'conf-input';
    awayInput.placeholder = '—';
    awayInput.min = String(Math.min(...range));
    awayInput.max = String(Math.max(...range));
    awayInput.dataset.side = 'away';
    awayInput.addEventListener('input', onConfidenceChange);
    const awayScore = document.createElement('span');
    awayScore.className = 'team-score';
    away.appendChild(awayScore);
    away.appendChild(awayInput);

    const kickoff = document.createElement('div');
    kickoff.className = 'kickoff';
    kickoff.textContent = new Date(g.date).toLocaleString();
    row.append(home, away, kickoff);
    gamesEl.appendChild(row);
  }

  // Add container for validation messages if missing
  if (!document.getElementById('errors')) {
    const errors = document.createElement('div');
    errors.id = 'errors';
    errors.className = 'hint';
    hintEl.insertAdjacentElement('afterend', errors);
  }
  updateValidationUI();
}

function onConfidenceChange(e) {
  const input = e.target;
  const row = input.closest('.game');
  const others = Array.from(row.querySelectorAll('.conf-input')).filter(i => i !== input);
  // If both sides filled, clear the other to avoid conflicts
  for (const o of others) {
    if (input.value && o.value) o.value = '';
  }
  updateValidationUI();
}

function getPicksFromUI() {
  const picks = [];
  for (const row of gamesEl.querySelectorAll('.game')) {
    const gameId = row.dataset.gameId;
    const inputs = row.querySelectorAll('.conf-input');
    const homeVal = inputs[0]?.value;
    const awayVal = inputs[1]?.value;
    if (homeVal && !awayVal) picks.push({ gameId, pick: 'home', confidence: Number(homeVal) });
    if (awayVal && !homeVal) picks.push({ gameId, pick: 'away', confidence: Number(awayVal) });
  }
  return picks;
}

function validatePicks(picks) {
  const range = confidenceRangeForCount(games.length);
  const min = Math.min(...range), max = Math.max(...range);
  // per-game: not both sides
  for (const row of gamesEl.querySelectorAll('.game')) {
    const inputs = row.querySelectorAll('.conf-input');
    if (inputs[0].value && inputs[1].value) return 'Choose only one team per game.';
  }
  // duplicates
  const values = picks.map(p => p.confidence);
  const set = new Set(values);
  if (values.length !== set.size) return 'Each confidence value must appear only once.';
  // range check
  for (const v of values) {
    if (v < min || v > max) return `Confidence must be between ${min} and ${max}.`;
  }
  // partial picks allowed
  return null;
}

function updateValidationUI() {
  const picks = getPicksFromUI();
  const errorsEl = document.getElementById('errors');
  // reset styles
  for (const input of gamesEl.querySelectorAll('.conf-input')) input.classList.remove('invalid');
  let msg = '';

  // per-game dual entry
  for (const row of gamesEl.querySelectorAll('.game')) {
    const inputs = row.querySelectorAll('.conf-input');
    if (inputs[0].value && inputs[1].value) {
      inputs[0].classList.add('invalid');
      inputs[1].classList.add('invalid');
      msg = 'Choose only one team per game.';
    }
  }

  // duplicates highlighting
  const valueMap = new Map();
  for (const row of gamesEl.querySelectorAll('.game')) {
    for (const input of row.querySelectorAll('.conf-input')) {
      const v = input.value && Number(input.value);
      if (!v) continue;
      if (!valueMap.has(v)) valueMap.set(v, []);
      valueMap.get(v).push(input);
    }
  }
  const dups = [...valueMap.entries()].filter(([, arr]) => arr.length > 1);
  if (dups.length) {
    for (const [, arr] of dups) arr.forEach(i => i.classList.add('invalid'));
    msg = msg || 'Each confidence value must appear only once.';
  }

  // out-of-range
  const range = confidenceRangeForCount(games.length);
  const min = Math.min(...range), max = Math.max(...range);
  for (const input of gamesEl.querySelectorAll('.conf-input')) {
    const v = input.value && Number(input.value);
    if (v && (v < min || v > max)) {
      input.classList.add('invalid');
      msg = msg || `Confidence must be between ${min} and ${max}.`;
    }
  }

  if (errorsEl) errorsEl.textContent = msg;
}

async function loadGames() {
  savePrefs();
  const season = Number(seasonEl.value);
  const week = Number(weekEl.value);
  if (!week) { alert('Enter week 1-18'); return; }
  const res = await fetch(`/api/games?season=${season}&week=${week}`);
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || `Failed to load games (HTTP ${res.status})`;
    alert(msg);
    games = [];
  } else {
    games = await res.json();
  }
  renderGames();
  await loadExistingPicks();
  await refreshScoreboard();
}

async function loadExistingPicks() {
  const user = userEl.value.trim();
  const season = Number(seasonEl.value);
  const week = Number(weekEl.value);
  if (!user) return;
  const res = await fetch(`/api/picks?user=${encodeURIComponent(user)}&season=${season}&week=${week}`);
  const picks = await res.json();
  const picksMap = Object.fromEntries(picks.map(p => [p.gameId, p]));

  // Fill UI
  for (const row of gamesEl.querySelectorAll('.game')) {
    const gameId = row.dataset.gameId;
    const pick = picksMap[gameId];
    const inputs = row.querySelectorAll('.conf-input');
    inputs[0].value = '';
    inputs[1].value = '';
    if (!pick) continue;
    if (pick.pick === 'home') inputs[0].value = String(pick.confidence);
    if (pick.pick === 'away') inputs[1].value = String(pick.confidence);
  }
  updateValidationUI();
}

async function savePicks() {
  savePrefs();
  const user = userEl.value.trim();
  if (!user) { alert('Enter a user name'); return; }
  const season = Number(seasonEl.value);
  const week = Number(weekEl.value);
  const picks = getPicksFromUI();
  const err = validatePicks(picks);
  if (err) { alert(err); return; }

  const res = await fetch('/api/picks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, season, week, picks })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed to save'); return; }
  alert('Saved!');
  await refreshScoreboard();
}

async function refreshScoreboard() {
  const season = Number(seasonEl.value);
  const week = Number(weekEl.value);
  if (!week) return;
  const res = await fetch(`/api/scoreboard?season=${season}&week=${week}`);
  const { scores, results } = await res.json();
  const rows = Object.entries(scores).sort((a,b) => b[1]-a[1]);
  scoreboardEl.innerHTML = rows.map(([user, score]) => `<div class="row"><div>${user}</div><div>${score}</div></div>`).join('') || '<div class="row">No scores yet.</div>';

  // Annotate games with current scores and winners
  const resMap = results || {};
  for (const row of gamesEl.querySelectorAll('.game')) {
    const gameId = row.dataset.gameId;
    const g = games.find(x => x.id === gameId);
  const hs = g.home.score != null ? g.home.score : '';
  const as = g.away.score != null ? g.away.score : '';
  const winner = resMap[gameId];
  const homeTeamEl = row.querySelector('.team.home');
  const awayTeamEl = row.querySelector('.team.away');
  const homeScoreEl = homeTeamEl.querySelector('.team-score');
  const awayScoreEl = awayTeamEl.querySelector('.team-score');
  homeScoreEl.textContent = hs;
  awayScoreEl.textContent = as;
  homeTeamEl.classList.toggle('winner', winner === 'home');
  awayTeamEl.classList.toggle('winner', winner === 'away');
  }
}

async function refreshResults() {
  const season = Number(seasonEl.value);
  const week = Number(weekEl.value);
  if (!week) return;
  await fetch('/api/update-results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ season, week })
  });
  await loadGames();
}

loadBtn.addEventListener('click', loadGames);
saveBtn.addEventListener('click', savePicks);
refreshResultsBtn.addEventListener('click', refreshResults);

(async function init() {
  restorePrefs();
  await fetchWeekInfo();
})();
