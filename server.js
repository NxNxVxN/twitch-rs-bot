const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CONFIG ----------
const PLATFORM = 'crossplay';
const API_BASE = 'https://api.the-finals-leaderboard.com/v1/leaderboard';
const SEASON_RECHECK_MS = 6 * 60 * 60 * 1000; // 6 hours
const KNOWN_BASELINE_SEASON = 7;
const FETCH_TIMEOUT_MS = 8000;

// Optional manual override - if set, skips auto-detection entirely and
// always uses this season id. Use this if auto-detection ever picks the
// wrong season; set SEASON_OVERRIDE in the hosting platform's env vars.
const SEASON_OVERRIDE = process.env.SEASON_OVERRIDE || '';

// The streamer's own Embark ID, used when ?name= is empty.
// Set this in the hosting platform's environment variables.
const STREAMER_EMBARK_ID = process.env.STREAMER_EMBARK_ID || '';

let currentSeason = null;
let seasonDetectedAt = 0;

// fetch with a hard timeout so a slow/stuck request can't hang the bot
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        // Ask for uncompressed responses - works around a node-fetch v2
        // bug (ERR_STREAM_PREMATURE_CLOSE) where gzip decompression
        // occasionally drops the connection mid-stream on some hosts.
        'Accept-Encoding': 'identity',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Retries a fetch-and-parse operation a couple times if it hits a
// transient network/stream error, since those are usually one-off blips.
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient =
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.type === 'aborted' ||
        err.name === 'AbortError' ||
        /premature close/i.test(err.message || '');
      if (!transient || i === attempts - 1) throw err;
      console.log(`Transient fetch error (attempt ${i + 1}/${attempts}): ${err.message}. Retrying...`);
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- SEASON AUTO-DETECTION ----------
async function seasonExists(seasonId) {
  try {
    const url = `${API_BASE}/${seasonId}/${PLATFORM}?count=true`;
    const data = await withRetry(async () => {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }, 2);
    const exists = typeof data.count === 'number' && data.count > 0;
    console.log(`seasonExists(${seasonId}): count=${data.count}, exists=${exists}`);
    return exists;
  } catch (err) {
    console.log(`seasonExists(${seasonId}): error - ${err.message}`);
    return false;
  }
}

async function detectCurrentSeason() {
  if (SEASON_OVERRIDE) {
    currentSeason = SEASON_OVERRIDE;
    seasonDetectedAt = Date.now();
    console.log(`Using manual SEASON_OVERRIDE: ${currentSeason}`);
    return currentSeason;
  }

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
  console.log(`Fetching: ${url}`);

  const data = await withRetry(async () => {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API responded with ${res.status} for season ${season}: ${body.slice(0, 200)}`);
    }
    return res.json();
  });

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
  const name = entry.name ?? 'unknown';
  const rank = entry.rank ?? '?';
  const league = entry.league ?? '';
  const score = entry.rankScore ?? entry.fame ?? entry.score ?? '?';
  const change = entry.change;

  let trend = '';
  if (typeof change === 'number') {
    if (change > 0) trend = ` up ${change}`;
    else if (change < 0) trend = ` down ${Math.abs(change)}`;
  }

  const parts = [`${name} rank ${rank}`, league, `${score} rs${trend}`].filter(Boolean);
  return parts.join(' ').toLowerCase();
}

// ---------- ROUTE ----------
// GET /rs?name=Nats#1234   (or ?name= empty/missing -> streamer's own ID)
//
// Two StreamElements command formats are supported, in case one fails to
// parse on a given account:
//
//   Primary (single-layer $() variable, no nesting):
//     $(urlfetch https://twitch-rs-bot.onrender.com/rs?name=$(query))
//     chat usage: !rs Balise#2431  or  !rs Balise
//
//   Fallback (if a literal "#" never survives StreamElements encoding -
//   it gets URL-encoded as "+" between words instead, no "#" needed):
//     same command, chat usage: !rs Balise 2431  (space instead of #)
//     this route reconstructs "Balise#2431" automatically when the last
//     word is purely numeric and no "#" is already present.
//
// This route still defensively re-decodes whatever arrives, in case of
// partial encoding or an unescaped "#" making it through some other way.
// Always responds with 200 + plain text, since StreamElements posts
// whatever text comes back verbatim into chat - no JSON, no error pages.
app.get('/rs', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');

  // Express splits the URL on "?" before we ever see req.query, so an
  // unescaped "#" in the name (e.g. "Balise#2431") is the main thing to
  // recover here - browsers/StreamElements may send it raw, or the route
  // may receive it already as part of req.query.name depending on how
  // urlfetch encoded the request. Handle both shapes defensively.
  let rawName = req.query.name;
  if (rawName === undefined) {
    // Fallback: pull everything after "name=" directly from the raw URL,
    // in case an unescaped "#" truncated query parsing.
    const match = req.originalUrl.match(/name=([^&]*)/);
    rawName = match ? match[1] : '';
  }

  let query = decodeURIComponent((rawName || '').replace(/\+/g, ' ')).trim();
  let lookingUpSelf = false;

  // Fallback for the case where a literal "#" never survives StreamElements'
  // variable encoding: if someone types "!rs Balise 2431" (name and tag
  // separated by a space instead of "#"), and the last word is purely
  // numeric, treat it as the tag and rebuild "Balise#2431" ourselves.
  // A real Embark ID never has a space, so this is safe - it only
  // triggers on the deliberate space-separated fallback format.
  const spaceTagMatch = query.match(/^(.+)\s+(\d{1,5})$/);
  if (spaceTagMatch && !query.includes('#')) {
    query = `${spaceTagMatch[1]}#${spaceTagMatch[2]}`;
  }

  console.log(`/rs called - raw query string: "${req.originalUrl}", resolved name: "${query}"`);

  if (!query) {
    if (!STREAMER_EMBARK_ID) {
      return res.send('no default streamer id configured');
    }
    query = STREAMER_EMBARK_ID;
    lookingUpSelf = true;
  }

  try {
    const result = await lookupPlayer(query);

    if (result.type === 'none') {
      const who = lookingUpSelf ? `streamer id ${query}` : `"${query}"`;
      return res.send(
        `couldn't find ${who} on the ranked leaderboard${lookingUpSelf ? '' : ', check spelling or they may be unranked'}`
      );
    }

    if (result.type === 'multiple') {
      const names = result.matches.slice(0, 5).map(e => e.name.toLowerCase()).join(', ');
      return res.send(`multiple matches for "${query}": ${names} - try the full tag`);
    }

    return res.send(formatStatsMessage(result.entry));
  } catch (err) {
    console.error('Lookup error:', err.message);
    return res.send('something went wrong fetching ranked stats, try again in a bit');
  }
});

// Debug route - shows current detected season and config status without
// exposing secrets. Useful for sanity-checking the live deployment.
// VERSION marker: bump this string any time server.js changes, so a quick
// /debug check confirms whether Render is actually running the latest code.
const SERVER_VERSION = 'v5-space-tag-fallback';

app.get('/debug', (req, res) => {
  res.json({
    version: SERVER_VERSION,
    currentSeason,
    seasonDetectedAt: seasonDetectedAt ? new Date(seasonDetectedAt).toISOString() : null,
    seasonOverrideSet: Boolean(SEASON_OVERRIDE),
    streamerIdSet: Boolean(STREAMER_EMBARK_ID),
  });
});

// Simple health check for the hosting platform / uptime pings.
app.get('/', (req, res) => {
  res.send('finals-rs-api is running.');
});

app.listen(PORT, () => {
  console.log(`finals-rs-api listening on port ${PORT}`);
});
