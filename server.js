const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CONFIG ----------
const PLATFORM = 'crossplay';
const API_BASE = 'https://api.the-finals-leaderboard.com/v1/leaderboard';
const SEASON_RECHECK_MS = 6 * 60 * 60 * 1000; // 6 hours
const KNOWN_BASELINE_SEASON = 7;

// The streamer's own Embark ID, used when ?name= is empty.
// Set this in the hosting platform's environment variables.
const STREAMER_EMBARK_ID = process.env.STREAMER_EMBARK_ID || '';

let currentSeason = null;
let seasonDetectedAt = 0;

// ---------- SEASON AUTO-DETECTION ----------
async function seasonExists(seasonId) {
  try {
    const url = `${API_BASE}/${seasonId}/${PLATFORM}?count=true`;
    const res = await fetch(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data.count === 'number' && data.count > 0;
  } catch {
    return false;
  }
}

async function detectCurrentSeason() {
  let best = `s${KNOWN_BASELINE_SEASON}`;
  let n = KNOWN_BASELINE_SEASON;
  while (await seasonExists(`s${n + 1}`)) {
    n += 1;
    best = `s${n}`;
  }
  currentSeason = best;
  seasonDetectedAt = Date.now();
  console.log(`Detected current season: ${currentSeason}`);
  return currentSeason;
}

async function getCurrentSeason() {
  const isStale = Date.now() - seasonDetectedAt > SEASON_RECHECK_MS;
  if (!currentSeason || isStale) {
    await detectCurrentSeason();
  }
  return currentSeason;
}

detectCurrentSeason().catch(err => console.error('Initial season detection failed:', err));

// ---------- LOOKUP LOGIC ----------
async function searchLeaderboard(query) {
  const season = await getCurrentSeason();
  const url = `${API_BASE}/${season}/${PLATFORM}?name=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
  if (!res.ok) throw new Error(`API responded with ${res.status}`);
  const data = await res.json();
  return data && data.data ? data.data : [];
}

async function lookupPlayer(query) {
  const entries = await searchLeaderboard(query);
  if (entries.length === 0) return { type: 'none' };

  const exact = entries.find(e => e.name && e.name.toLowerCase() === query.toLowerCase());
  if (exact) return { type: 'single', entry: exact };

  if (entries.length === 1) return { type: 'single', entry: entries[0] };

  return { type: 'multiple', matches: entries };
}

function formatStatsMessage(entry) {
  const name = entry.name ?? 'Unknown';
  const rank = entry.rank ?? '?';
  const league = entry.league ?? '';
  const score = entry.rankScore ?? entry.fame ?? entry.score ?? '?';
  const change = entry.change;

  let trend = '';
  if (typeof change === 'number') {
    if (change > 0) trend = ` (+${change})`;
    else if (change < 0) trend = ` (${change})`;
  }

  return `${name} is rank #${rank}${league ? ` [${league}]` : ''} with ${score} RS${trend}.`;
}

// ---------- ROUTE ----------
// GET /rs?name=Nats#1234   (or ?name= empty/missing -> streamer's own ID)
// Always responds with 200 + plain text, since StreamElements posts
// whatever text comes back verbatim into chat - no JSON, no error pages.
app.get('/rs', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');

  let query = (req.query.name || '').trim();
  let lookingUpSelf = false;

  if (!query) {
    if (!STREAMER_EMBARK_ID) {
      return res.send('No default streamer ID is configured for this bot.');
    }
    query = STREAMER_EMBARK_ID;
    lookingUpSelf = true;
  }

  try {
    const result = await lookupPlayer(query);

    if (result.type === 'none') {
      const who = lookingUpSelf ? `the streamer's ID (${query})` : `"${query}"`;
      return res.send(
        `Couldn't find ${who} on the ranked leaderboard. ${
          lookingUpSelf
            ? 'Check the STREAMER_EMBARK_ID setting.'
            : 'Check the spelling, or they may be unranked / outside the top 10,000.'
        }`
      );
    }

    if (result.type === 'multiple') {
      const names = result.matches.slice(0, 5).map(e => e.name).join(', ');
      const more = result.matches.length > 5 ? ` (+${result.matches.length - 5} more)` : '';
      return res.send(
        `Multiple players match "${query}": ${names}${more}. Try again with the full tag, e.g. !rs ${result.matches[0].name}`
      );
    }

    return res.send(formatStatsMessage(result.entry));
  } catch (err) {
    console.error('Lookup error:', err);
    return res.send('Something went wrong fetching ranked stats. Try again in a bit.');
  }
});

// Simple health check for the hosting platform / uptime pings.
app.get('/', (req, res) => {
  res.send('finals-rs-api is running.');
});

app.listen(PORT, () => {
  console.log(`finals-rs-api listening on port ${PORT}`);
});
