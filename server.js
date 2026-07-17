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
const MAX_RANK = 10000; // leaderboard API only covers top 10,000

// History tracking config (for /rsup - "how much RS up in last N hours").
// In-memory only: resets on restart/redeploy, and pauses while the free
// tier is spun down from inactivity. See README for details.
const HISTORY_POLL_INTERVAL_MS = 30 * 60 * 1000; // snapshot every 30 min
const HISTORY_MAX_AGE_MS = 25 * 60 * 60 * 1000; // keep ~25h of snapshots
const HISTORY_MAX_HOURS = 24;
const HISTORY_MIN_HOURS = 1;

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

// ---------- SPECIAL-CASE RESPONSES ----------
// Some names get a canned, funny reply instead of a real leaderboard
// lookup - keyed by in-game name only (the part before "#"), lowercase.
// Add more entries here the same way if other regulars want the same
// treatment.

// Shuffle-bag picker: hands out entries in random order without repeating
// one until every other entry in the list has been shown, and avoids an
// immediate repeat across reshuffles too.
function makeShuffleBag(items) {
  let bag = [];
  let lastPicked = null;

  function refill() {
    bag = [...items];
    // Fisher-Yates shuffle
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // Avoid the new bag starting with the same line that just ended the last one
    if (bag.length > 1 && bag[0] === lastPicked) {
      [bag[0], bag[1]] = [bag[1], bag[0]];
    }
  }

  return function pick() {
    if (bag.length === 0) refill();
    const next = bag.pop();
    lastPicked = next;
    return next;
  };
}

const stormmehulRoasts = [
  "stormmehul has no rank because Diamond doesn't exist in Bronze lobbies.",
  "stormmehul's last ranked win was a rumor, never confirmed.",
  "checked the leaderboard twice, still no stormmehul - some legends are unranked by choice (and skill).",
  "stormmehul is rank #never [Bronze -1] with -9999 RS (still queuing).",
  "stormmehul isn't on the leaderboard because the servers have mercy.",
];
const pickStormmehulRoast = makeShuffleBag(stormmehulRoasts);

const NAME_OVERRIDES = {
  stormmehul: pickStormmehulRoast,
};

// ---------- LOOKUP LOGIC (by name) ----------
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
  const allEntries = await searchLeaderboard(query);
  if (allEntries.length === 0) return { type: 'none' };

  // The leaderboard API matches against steamName/psnName/xboxName too, not
  // just the in-game Embark name - that surfaces unrelated players whose
  // platform alias happens to contain the search term (e.g. searching
  // "ekazo" can match someone named "EkaZo Bot" on Steam who has a totally
  // different Embark ID). We only want results whose actual in-game name
  // (the part before "#") contains the search term.
  const queryLower = query.toLowerCase();
  const entries = allEntries.filter(e => {
    const inGameName = (e.name || '').split('#')[0].toLowerCase();
    return inGameName.includes(queryLower.split('#')[0]);
  });

  if (entries.length === 0) return { type: 'none' };

  const exact = entries.find(e => e.name && e.name.toLowerCase() === queryLower);
  if (exact) return { type: 'single', entry: exact };

  if (entries.length === 1) return { type: 'single', entry: entries[0] };

  return { type: 'multiple', matches: entries };
}

// ---------- LOOKUP LOGIC (by rank number) ----------
// Fetches the full leaderboard for the current season (no name filter) and
// finds the entry whose "rank" field matches the requested number.
async function lookupByRank(rankNum) {
  const season = await getCurrentSeason();
  const url = `${API_BASE}/${season}/${PLATFORM}`;
  console.log(`Fetching (rank lookup): ${url}`);

  const data = await withRetry(async () => {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API responded with ${res.status} for season ${season}: ${body.slice(0, 200)}`);
    }
    return res.json();
  });

  const entries = data && data.data ? data.data : [];
  return entries.find(e => e.rank === rankNum) || null;
}

// ---------- LOOKUP LOGIC (RS gap between two ranks) ----------
// Fetches the full leaderboard once and pulls out both requested ranks,
// rather than calling lookupByRank twice (which would fetch the whole
// leaderboard twice for no reason).
async function lookupRankGap(rankA, rankB) {
  const season = await getCurrentSeason();
  const url = `${API_BASE}/${season}/${PLATFORM}`;
  console.log(`Fetching (rank gap lookup): ${url}`);

  const data = await withRetry(async () => {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API responded with ${res.status} for season ${season}: ${body.slice(0, 200)}`);
    }
    return res.json();
  });

  const entries = data && data.data ? data.data : [];
  const entryA = entries.find(e => e.rank === rankA) || null;
  const entryB = entries.find(e => e.rank === rankB) || null;
  return { entryA, entryB };
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

// ---------- HISTORY TRACKING (for /rsup) ----------
// In-memory only. Polls the full leaderboard periodically and keeps a
// rolling window of snapshots so we can diff a player's RS against
// "N hours ago". Resets on restart/redeploy and pauses while the free
// tier is spun down from inactivity - see README.
let leaderboardHistory = []; // [{ timestamp, players: Map<lowercaseName, {name, rank, score}> }]

async function pollFullLeaderboardSnapshot() {
  try {
    const season = await getCurrentSeason();
    const url = `${API_BASE}/${season}/${PLATFORM}`;
    console.log(`Fetching (history snapshot): ${url}`);

    const data = await withRetry(async () => {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'finals-rs-api/1.0' } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API responded with ${res.status} for season ${season}: ${body.slice(0, 200)}`);
      }
      return res.json();
    });

    const entries = data && data.data ? data.data : [];
    const players = new Map();
    for (const e of entries) {
      if (!e.name) continue;
      players.set(e.name.toLowerCase(), {
        name: e.name,
        rank: e.rank,
        score: e.rankScore ?? e.fame ?? e.score ?? null,
      });
    }

    leaderboardHistory.push({ timestamp: Date.now(), players });
    pruneHistory();
    console.log(`History snapshot taken: ${players.size} players tracked, ${leaderboardHistory.length} snapshots in memory`);
  } catch (err) {
    console.error('History snapshot failed:', err.message);
  }
}

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  while (leaderboardHistory.length && leaderboardHistory[0].timestamp < cutoff) {
    leaderboardHistory.shift();
  }
}

// Finds the snapshot whose timestamp is closest to the target time.
// Returns null if no snapshots have been taken yet.
function findClosestSnapshot(targetTimestamp) {
  if (leaderboardHistory.length === 0) return null;
  let closest = leaderboardHistory[0];
  let closestDiff = Math.abs(closest.timestamp - targetTimestamp);
  for (const snap of leaderboardHistory) {
    const diff = Math.abs(snap.timestamp - targetTimestamp);
    if (diff < closestDiff) {
      closest = snap;
      closestDiff = diff;
    }
  }
  return closest;
}

// Kick off the first snapshot at boot, then keep polling on an interval.
pollFullLeaderboardSnapshot().catch(err => console.error('Initial history snapshot failed:', err));
setInterval(() => {
  pollFullLeaderboardSnapshot().catch(err => console.error('Scheduled history snapshot failed:', err));
}, HISTORY_POLL_INTERVAL_MS);

// ---------- ROUTE: /rs (lookup by name) ----------
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

  // Special-case names (e.g. stormmehul) get a canned funny reply instead
  // of a real leaderboard lookup. Matches on the in-game name only (before
  // "#"), case-insensitive, so "stormmehul", "StormMehul#1234", and the
  // space-separated fallback format all trigger it.
  const nameOnly = query.split('#')[0].toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAME_OVERRIDES, nameOnly)) {
    return res.send(NAME_OVERRIDES[nameOnly]());
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
      // Suggest the space-separated format ("!rs name tag"), not "name#tag" -
      // a literal "#" gets stripped by URL-fragment behavior before this
      // server ever sees it, so suggesting it would just send people back
      // into the same dead end. The space format is what actually works,
      // and these are ready to copy-paste straight back into chat.
      const suggestions = result.matches
        .slice(0, 3)
        .map(e => {
          const [namePart, tagPart] = e.name.split('#');
          return tagPart ? `!rs ${namePart.toLowerCase()} ${tagPart}` : `!rs ${e.name.toLowerCase()}`;
        })
        .join(' or ');
      return res.send(`multiple matches for "${query}" - try: ${suggestions}`);
    }

    return res.send(formatStatsMessage(result.entry));
  } catch (err) {
    console.error('Lookup error:', err.message);
    return res.send('something went wrong fetching ranked stats, try again in a bit');
  }
});

// ---------- ROUTE: /rank (lookup by rank number) ----------
// GET /rank?n=5   -> replies with whoever currently holds rank #5
//
// Chat usage: !rank 5
app.get('/rank', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');

  const raw = (req.query.n ?? req.query.rank ?? '').toString().trim();
  console.log(`/rank called - raw query string: "${req.originalUrl}", resolved rank: "${raw}"`);

  const rankNum = parseInt(raw, 10);
  if (!raw || Number.isNaN(rankNum) || rankNum < 1 || rankNum > MAX_RANK) {
    return res.send(`give me a rank number between 1 and ${MAX_RANK}, e.g. !rank 5`);
  }

  try {
    const entry = await lookupByRank(rankNum);
    if (!entry) {
      return res.send(`nobody found at rank #${rankNum} right now`);
    }
    return res.send(formatStatsMessage(entry));
  } catch (err) {
    console.error('Rank lookup error:', err.message);
    return res.send('something went wrong fetching that rank, try again in a bit');
  }
});

// ---------- ROUTE: /rsup (RS change over the last N hours) ----------
// GET /rsup?name=Nats#1234&hours=24
//
// Unlike /rs, this route does NOT support the space-separated "name tag"
// fallback format, since the second word is reserved for the hours
// argument here. Use a partial name (fuzzy-matched, like /rs) or the full
// "name#tag" if the "#" survives your StreamElements setup.
//
// Chat usage:
//   !rsup Nats#1234 24   -> RS change for Nats#1234 over ~24h
//   !rsup Nats 12        -> partial name match, ~12h window
//   !rsup                -> streamer's own id, default 24h window
app.get('/rsup', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');

  let rawName = req.query.name;
  if (rawName === undefined) {
    const match = req.originalUrl.match(/name=([^&]*)/);
    rawName = match ? match[1] : '';
  }
  let query = decodeURIComponent((rawName || '').replace(/\+/g, ' ')).trim();
  let lookingUpSelf = false;

  if (!query) {
    if (!STREAMER_EMBARK_ID) {
      return res.send('no default streamer id configured');
    }
    query = STREAMER_EMBARK_ID;
    lookingUpSelf = true;
  }

  let hours = parseInt((req.query.hours || '').toString().trim(), 10);
  if (Number.isNaN(hours)) hours = HISTORY_MAX_HOURS;
  hours = Math.min(Math.max(hours, HISTORY_MIN_HOURS), HISTORY_MAX_HOURS);

  console.log(`/rsup called - raw query string: "${req.originalUrl}", resolved name: "${query}", hours: ${hours}`);

  try {
    const result = await lookupPlayer(query);

    if (result.type === 'none') {
      const who = lookingUpSelf ? `streamer id ${query}` : `"${query}"`;
      return res.send(`couldn't find ${who} on the ranked leaderboard`);
    }

    if (result.type === 'multiple') {
      const names = result.matches.slice(0, 3).map(e => e.name).join(', ');
      return res.send(`multiple matches for "${query}": ${names} - specify more of the tag`);
    }

    const currentEntry = result.entry;
    const currentScore = currentEntry.rankScore ?? currentEntry.fame ?? currentEntry.score ?? null;
    if (currentScore === null) {
      return res.send(`no score data available for ${currentEntry.name}`);
    }

    const targetTimestamp = Date.now() - hours * 60 * 60 * 1000;
    const snapshot = findClosestSnapshot(targetTimestamp);

    if (!snapshot) {
      return res.send('still building up history for this - check back in a bit');
    }

    const past = snapshot.players.get(currentEntry.name.toLowerCase());
    const actualHours = ((Date.now() - snapshot.timestamp) / (60 * 60 * 1000)).toFixed(1);

    if (!past || past.score === null || past.score === undefined) {
      return res.send(
        `${currentEntry.name} wasn't tracked ~${actualHours}h ago (unranked or outside top ${MAX_RANK} then) - try again once more history builds up`
      );
    }

    const delta = currentScore - past.score;
    const trend = delta > 0 ? `up ${delta}` : delta < 0 ? `down ${Math.abs(delta)}` : 'unchanged';

    let rankTrend = '';
    if (typeof past.rank === 'number' && typeof currentEntry.rank === 'number' && past.rank !== currentEntry.rank) {
      const rankDelta = past.rank - currentEntry.rank; // positive = moved to a better (lower) rank number
      rankTrend = rankDelta > 0 ? `, rank up ${rankDelta}` : `, rank down ${Math.abs(rankDelta)}`;
    }

    return res.send(
      `${currentEntry.name} is ${trend} rs over the last ~${actualHours}h${rankTrend} (now rank ${currentEntry.rank}, ${currentScore} rs)`.toLowerCase()
    );
  } catch (err) {
    console.error('rsup error:', err.message);
    return res.send('something went wrong calculating that, try again in a bit');
  }
});

// ---------- ROUTE: /rankgap (RS difference between two ranks) ----------
// GET /rankgap?a=1&b=2   -> RS gap between rank #1 and rank #2
// Defaults to a=1, b=2 if either is missing/invalid.
//
// Chat usage: !rankgap 1 2   or just   !rankgap   (defaults to 1 vs 2)
app.get('/rankgap', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');

  let rankA = parseInt((req.query.a || '').toString().trim(), 10);
  let rankB = parseInt((req.query.b || '').toString().trim(), 10);
  if (Number.isNaN(rankA) || rankA < 1 || rankA > MAX_RANK) rankA = 1;
  if (Number.isNaN(rankB) || rankB < 1 || rankB > MAX_RANK) rankB = 2;

  console.log(`/rankgap called - raw query string: "${req.originalUrl}", resolved: rank ${rankA} vs rank ${rankB}`);

  if (rankA === rankB) {
    return res.send(`rank ${rankA} and rank ${rankB} are the same rank, gap is 0`);
  }

  try {
    const { entryA, entryB } = await lookupRankGap(rankA, rankB);

    if (!entryA || !entryB) {
      const missing = !entryA ? rankA : rankB;
      return res.send(`nobody found at rank #${missing} right now`);
    }

    const scoreA = entryA.rankScore ?? entryA.fame ?? entryA.score ?? null;
    const scoreB = entryB.rankScore ?? entryB.fame ?? entryB.score ?? null;

    if (scoreA === null || scoreB === null) {
      return res.send('score data unavailable for one of those ranks');
    }

    const gap = Math.abs(scoreA - scoreB);
    const ahead = scoreA >= scoreB ? entryA : entryB;
    const behind = scoreA >= scoreB ? entryB : entryA;
    const aheadRank = scoreA >= scoreB ? rankA : rankB;
    const behindRank = scoreA >= scoreB ? rankB : rankA;

    return res.send(
      `rank ${aheadRank} (${ahead.name}) is ${gap} rs ahead of rank ${behindRank} (${behind.name})`.toLowerCase()
    );
  } catch (err) {
    console.error('rankgap error:', err.message);
    return res.send('something went wrong calculating that gap, try again in a bit');
  }
});

// Debug route - shows current detected season and config status without
// exposing secrets. Useful for sanity-checking the live deployment.
// VERSION marker: bump this string any time server.js changes, so a quick
// /debug check confirms whether Render is actually running the latest code.
const SERVER_VERSION = 'v13-rankgap';

app.get('/debug', (req, res) => {
  res.json({
    version: SERVER_VERSION,
    currentSeason,
    seasonDetectedAt: seasonDetectedAt ? new Date(seasonDetectedAt).toISOString() : null,
    seasonOverrideSet: Boolean(SEASON_OVERRIDE),
    streamerIdSet: Boolean(STREAMER_EMBARK_ID),
    historySnapshots: leaderboardHistory.length,
    oldestSnapshot: leaderboardHistory.length ? new Date(leaderboardHistory[0].timestamp).toISOString() : null,
    newestSnapshot: leaderboardHistory.length ? new Date(leaderboardHistory[leaderboardHistory.length - 1].timestamp).toISOString() : null,
  });
});

// Simple health check for the hosting platform / uptime pings.
app.get('/', (req, res) => {
  res.send('finals-rs-api is running.');
});

app.listen(PORT, () => {
  console.log(`finals-rs-api listening on port ${PORT}`);
});
