# NFL Confidence Picks

A lightweight web app for making NFL weekly confidence picks (16 down to 1). It fetches the week's games from ESPN, lets users assign unique confidence points to their picks, and automatically tallies scores from completed games.

## Features
- Fetch NFL games for a given season/week.
- Enforce unique confidence values across all games.
- Save picks per user.
- Auto-update results hourly and on-demand, compute weekly scores, and display a scoreboard.

## Run locally

1. Install Node.js 18+.
2. Install dependencies and start the server.

```powershell
npm install
npm run dev
```

Open http://localhost:3000

## Notes
- Data source: ESPN public scoreboard API.
- Results update via cron (midnight) and via the "Refresh Results" button.
- Simple JSON file `db.json` is used for storage in this folder.

## Caveats
- If a game ends in a tie, no points are awarded.
- Confidence range logic: always uses top value 16. If fewer games exist, it descends from 16 for the needed count (e.g., 14 games => 16..3).
