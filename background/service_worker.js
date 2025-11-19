const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const DATA_VERSION = 3;
const STORAGE_KEYS = {
  PLAYERS: 'sleeperPlus:players',
  STATS: 'sleeperPlus:stats',
  METRICS: 'sleeperPlus:metrics',
};
const LAST_REFRESH_METADATA_KEY = 'sleeperPlus:lastDataRefresh';

const API_BASE_URL = 'https://api.sleeper.app/v1';
const PROJECTION_API_BASE_URL = 'https://api.sleeper.com';
const PLAYER_SNAPSHOT_ALARM = 'sleeperPlus:refreshPlayers';
const LEAGUE_SNAPSHOT_ALARM = 'sleeperPlus:refreshLeagueStats';
const PLAYER_DATA_TTL_MS = ONE_DAY_MS;
const LEAGUE_DATA_TTL_MS = 3 * ONE_HOUR_MS;
const MATCHUP_CACHE_TTL_MS = 30 * 1000;
const STATE_CACHE_TTL_MS = 60 * 1000;

const matchupCache = new Map();
let stateCacheEnvelope = null;
let inflightStateRequest = null;

const asyncChrome = {
  storageLocalGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(result || {});
      });
    });
  },
  storageLocalSet(entries) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(entries, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  },
};

const setLastRefreshMetadata = async ({ source = 'auto', leagueCount = 0 } = {}) => {
  await asyncChrome.storageLocalSet({
    [LAST_REFRESH_METADATA_KEY]: {
      timestamp: Date.now(),
      source,
      leagueCount,
    },
  });
};

const buildCacheEnvelope = (payload) => ({
  version: DATA_VERSION,
  updatedAt: Date.now(),
  payload,
});

const getCacheEnvelope = async (key) => {
  const result = await asyncChrome.storageLocalGet([key]);
  return result[key] || null;
};

const setCacheEnvelope = async (key, payload) => {
  await asyncChrome.storageLocalSet({ [key]: buildCacheEnvelope(payload) });
};

const isEnvelopeFresh = (envelope, ttlMs) => {
  if (!envelope || envelope.version !== DATA_VERSION) {
    return false;
  }
  const age = Date.now() - envelope.updatedAt;
  return age < ttlMs;
};

const delay = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const fetchJson = async (path, init = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const error = new Error(`Sleeper API ${path} failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

const fetchProjectionJson = async (path, init = {}) => {
  const response = await fetch(`${PROJECTION_API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const error = new Error(`Sleeper projections ${path} failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

const fetchNflState = async ({ force = false } = {}) => {
  const hasFreshCache =
    !force && stateCacheEnvelope && Date.now() - stateCacheEnvelope.timestamp < STATE_CACHE_TTL_MS;
  if (hasFreshCache) {
    return stateCacheEnvelope.payload;
  }
  if (!force && inflightStateRequest) {
    return inflightStateRequest;
  }
  const request = fetchJson('/state/nfl')
    .then((payload) => {
      stateCacheEnvelope = { payload, timestamp: Date.now() };
      inflightStateRequest = null;
      return payload;
    })
    .catch((error) => {
      inflightStateRequest = null;
      throw error;
    });
  inflightStateRequest = request;
  return request;
};

const normalizeLeagueId = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const match = trimmed.match(/leagues\/([^/?#]+)/i);
  if (match && match[1]) {
    return match[1];
  }
  return trimmed;
};

const sanitizeLeagueIdList = (input) => {
  const list = Array.isArray(input) ? input : [input];
  const collected = [];
  list
    .map((value) => normalizeLeagueId(String(value ?? '')))
    .filter(Boolean)
    .forEach((id) => {
      if (!collected.includes(id)) {
        collected.push(id);
      }
    });
  return collected;
};

const sanitizeRosterId = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
};

const sanitizePlayerIdList = (input) => {
  if (!input && input !== 0) {
    return [];
  }
  const list = Array.isArray(input) ? input : [input];
  const collected = [];
  const seen = new Set();
  list
    .map((value) => (value === null || value === undefined ? '' : String(value).trim()))
    .filter(Boolean)
    .forEach((playerId) => {
      if (seen.has(playerId)) {
        return;
      }
      seen.add(playerId);
      collected.push(playerId);
    });
  return collected;
};

const areStarterListsEqual = (listA, listB) => {
  if (!Array.isArray(listA) || !Array.isArray(listB) || listA.length !== listB.length) {
    return false;
  }
  const sortedA = sanitizePlayerIdList(listA).sort();
  const sortedB = sanitizePlayerIdList(listB).sort();
  if (sortedA.length !== sortedB.length) {
    return false;
  }
  for (let index = 0; index < sortedA.length; index += 1) {
    if (sortedA[index] !== sortedB[index]) {
      return false;
    }
  }
  return true;
};

const findBestMatchupByPlayerIds = (matchups, playerIds) => {
  if (!Array.isArray(matchups) || matchups.length === 0 || playerIds.length === 0) {
    return null;
  }
  const sanitizedPlayers = sanitizePlayerIdList(playerIds);
  if (sanitizedPlayers.length === 0) {
    return null;
  }
  const playerSet = new Set(sanitizedPlayers);
  let bestMatch = null;
  let bestScore = 0;
  for (let index = 0; index < matchups.length; index += 1) {
    const entry = matchups[index];
    const entryPlayers = sanitizePlayerIdList(entry?.starters || []);
    if (entryPlayers.length === 0) {
      continue;
    }
    let score = 0;
    for (let playerIndex = 0; playerIndex < entryPlayers.length; playerIndex += 1) {
      if (playerSet.has(entryPlayers[playerIndex])) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }
  return bestScore > 0 ? bestMatch : null;
};

const getTrackedLeagueIds = () =>
  new Promise((resolve) => {
    chrome.storage.sync.get(['leagueIds', 'leagueId'], (result) => {
      if (chrome.runtime.lastError) {
        console.warn('Sleeper+ unable to read league IDs', chrome.runtime.lastError);
        resolve([]);
        return;
      }
      const raw = result.leagueIds ?? result.leagueId ?? [];
      resolve(sanitizeLeagueIdList(raw));
    });
  });

let playerDirectoryRefreshPromise = null;

const ensureDefaultStorage = async () => {
  const [players, stats, metrics] = await Promise.all([
    getCacheEnvelope(STORAGE_KEYS.PLAYERS),
    getCacheEnvelope(STORAGE_KEYS.STATS),
    getCacheEnvelope(STORAGE_KEYS.METRICS),
  ]);

  const updates = {};
  if (!players) {
    updates[STORAGE_KEYS.PLAYERS] = buildCacheEnvelope({
      lastSync: null,
      records: {},
    });
  }
  if (!stats) {
    updates[STORAGE_KEYS.STATS] = buildCacheEnvelope({ lastSync: null, byLeague: {} });
  }
  if (!metrics) {
    updates[STORAGE_KEYS.METRICS] = buildCacheEnvelope({ lastSync: null, summary: {} });
  }

  if (Object.keys(updates).length > 0) {
    await asyncChrome.storageLocalSet(updates);
  }
};

const slimPlayerRecord = (player) => ({
  player_id: player.player_id,
  full_name: player.full_name,
  first_name: player.first_name,
  last_name: player.last_name,
  search_full_name:
    player.search_full_name || player.metadata?.search_full_name || player.full_name?.toLowerCase() || '',
  team: player.team,
  position: player.position,
  fantasy_positions: player.fantasy_positions,
  metadata_position:
    player.metadata?.position ||
    player.metadata?.primary_position ||
    player.metadata?.depth_chart_position ||
    player.metadata?.status,
  age: player.age,
  years_exp: player.years_exp,
});

const derivePrimaryPosition = (record) => {
  if (!record) {
    return 'UNK';
  }
  return (
    (Array.isArray(record.fantasy_positions) && record.fantasy_positions.find(Boolean)) ||
    record.position ||
    record.metadata_position ||
    'UNK'
  );
};

const TEAM_CODE_ALIASES = {
  JAC: 'JAX',
  WSH: 'WAS',
};

const OPPONENT_OBJECT_FIELDS = [
  'abbr',
  'abbreviation',
  'alias',
  'team',
  'team_abbr',
  'team_abbreviation',
  'teamAlias',
  'teamAliasAbbr',
  'short_name',
  'shortName',
  'display_name',
  'displayName',
  'name',
  'code',
  'opponent',
  'opponent_abbr',
  'opponentAbbr',
];

const normalizeOpponentCode = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const normalized = normalizeOpponentCode(value[index]);
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }
  if (typeof value === 'object') {
    for (let index = 0; index < OPPONENT_OBJECT_FIELDS.length; index += 1) {
      const field = OPPONENT_OBJECT_FIELDS[index];
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        const normalized = normalizeOpponentCode(value[field]);
        if (normalized) {
          return normalized;
        }
      }
    }
    return '';
  }
  const normalized = value.toString().toUpperCase().replace(/[^A-Z]/g, '');
  if (!normalized || normalized === 'BYE') {
    return '';
  }
  return TEAM_CODE_ALIASES[normalized] || normalized;
};

const resolveNormalizedOpponent = (...candidates) => {
  for (let index = 0; index < candidates.length; index += 1) {
    const normalized = normalizeOpponentCode(candidates[index]);
    if (normalized) {
      return normalized;
    }
  }
  return '';
};

const buildOpponentRankMap = (totalsByPosition = {}, countsByPosition = {}) => {
  const ranks = {};
  Object.entries(totalsByPosition).forEach(([position, teamTotals]) => {
    const entriesForPosition = Object.entries(teamTotals)
      .map(([team, total]) => ({
        team,
        total,
        count: countsByPosition?.[position]?.[team] || 0,
      }))
      .sort((a, b) => b.total - a.total);
    if (entriesForPosition.length === 0) {
      return;
    }
    const scale = entriesForPosition.length;
    ranks[position] = {};
    entriesForPosition.forEach((entry, index) => {
      const teamCode = entry.team.toUpperCase();
      ranks[position][teamCode] = {
        rank: index + 1,
        total: Number(entry.total.toFixed(2)),
        count: entry.count,
        scale,
      };
    });
  });
  return ranks;
};

const DEFAULT_SCORING_WEIGHTS = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
  fum_lost: -2,
  bonus_pass_yd_300: 3,
  bonus_pass_yd_400: 4,
  bonus_rush_yd_100: 3,
  bonus_rush_yd_200: 5,
  bonus_rec_yd_100: 3,
  bonus_rec_yd_200: 5,
};

const buildScoringWeights = (scoringSettings) => {
  if (!scoringSettings || typeof scoringSettings !== 'object') {
    return { ...DEFAULT_SCORING_WEIGHTS };
  }
  return { ...DEFAULT_SCORING_WEIGHTS, ...scoringSettings };
};

const calculateFantasyPoints = (stats, scoringWeights) => {
  if (!stats || typeof stats !== 'object') {
    return null;
  }
  let total = 0;
  let applied = false;
  Object.entries(scoringWeights).forEach(([category, weight]) => {
    if (!Number.isFinite(weight) || weight === 0) {
      return;
    }
    const statValue = Number(stats[category]);
    if (!Number.isFinite(statValue) || statValue === 0) {
      return;
    }
    total += statValue * weight;
    applied = true;
  });
  if (!applied) {
    return null;
  }
  return Number(total.toFixed(2));
};

const normalizeProjectionMap = (payload, scoringSettings) => {
  if (!payload || typeof payload !== 'object') {
    return { projections: {}, opponents: {} };
  }
  const scoringWeights = buildScoringWeights(scoringSettings);
  const projections = {};
  const opponents = {};
  const fallbackPointFields = ['pts_ppr', 'pts_half_ppr', 'pts_std'];

  const applyEntry = (playerId, stats, metadata = {}) => {
    if (!playerId || !stats || typeof stats !== 'object') {
      return;
    }
    const resolvedOpponent = resolveNormalizedOpponent(
      metadata.opponent,
      metadata.opponent_team,
      stats.opponent,
      stats.opp,
      stats.opponent_team,
      stats.opponentTeam,
      stats.opponent_abbr,
      stats.schedule?.opponent,
      stats.schedule?.opponent_team,
      stats.schedule,
      stats.team?.opponent,
      stats.team?.opponent_team,
      stats.team,
      stats.team_opponent,
      stats.matchup?.opponent,
      stats.matchup?.opponent_team,
      stats.matchup,
      stats.meta?.opponent
    );
    const assignOpponent = () => {
      if (resolvedOpponent) {
        opponents[playerId] = resolvedOpponent;
      }
    };
    const projectedPoints = calculateFantasyPoints(stats, scoringWeights);
    const applyPoints = (value) => {
      projections[playerId] = Number(value.toFixed(2));
      assignOpponent();
    };

    if (projectedPoints !== null) {
      applyPoints(projectedPoints);
      return;
    }
    for (const field of fallbackPointFields) {
      const fallbackValue = Number(stats[field]);
      if (Number.isFinite(fallbackValue)) {
        applyPoints(fallbackValue);
        return;
      }
    }
    assignOpponent();
  };

  if (Array.isArray(payload)) {
    payload.forEach((entry) => {
      const playerId = entry?.player_id || entry?.player?.player_id;
      const opponent = entry?.opponent || entry?.opp || null;
      applyEntry(playerId, entry?.stats || entry, { opponent });
    });
  } else {
    Object.entries(payload).forEach(([playerId, stats]) => {
      applyEntry(playerId, stats, {});
    });
  }

  return { projections, opponents };
};

const normalizeStatsMap = (payload, scoringSettings) => {
  if (!payload || typeof payload !== 'object') {
    return { actuals: {}, opponents: {} };
  }
  const scoringWeights = buildScoringWeights(scoringSettings);
  const actuals = {};
  const opponents = {};
  const fallbackPointFields = ['pts_ppr', 'pts_half_ppr', 'pts_std'];

  const applyEntry = (playerId, stats, metadata = {}) => {
    if (!playerId || !stats || typeof stats !== 'object') {
      return;
    }
    const resolvedOpponent = resolveNormalizedOpponent(
      metadata.opponent,
      metadata.opponent_team,
      stats.opponent,
      stats.opp,
      stats.opponent_team,
      stats.opponentTeam,
      stats.opponent_abbr,
      stats.schedule?.opponent,
      stats.schedule?.opponent_team,
      stats.schedule,
      stats.team?.opponent,
      stats.team?.opponent_team,
      stats.team,
      stats.team_opponent,
      stats.matchup?.opponent,
      stats.matchup?.opponent_team,
      stats.matchup,
      stats.meta?.opponent
    );
    const assignOpponent = () => {
      if (resolvedOpponent) {
        opponents[playerId] = resolvedOpponent;
      }
    };
    const fantasyPoints = calculateFantasyPoints(stats, scoringWeights);
    const applyPoints = (value) => {
      actuals[playerId] = Number(value.toFixed(2));
      assignOpponent();
    };

    if (fantasyPoints !== null) {
      applyPoints(fantasyPoints);
      return;
    }
    for (const field of fallbackPointFields) {
      const fallbackValue = Number(stats[field]);
      if (Number.isFinite(fallbackValue)) {
        applyPoints(fallbackValue);
        return;
      }
    }
    assignOpponent();
  };

  if (Array.isArray(payload)) {
    payload.forEach((entry) => {
      const playerId = entry?.player_id || entry?.player?.player_id;
      const opponent = entry?.opponent || entry?.opp || null;
      applyEntry(playerId, entry?.stats || entry, { opponent });
    });
  } else {
    Object.entries(payload).forEach(([playerId, stats]) => {
      applyEntry(playerId, stats, {});
    });
  }

  return { actuals, opponents };
};

const fetchWeekProjectionMap = async ({ season, week, seasonType = 'regular', scoringSettings }) => {
  const queries = [
    {
      label: 'projection feed',
      fetcher: () =>
        fetchProjectionJson(
          `/projections/nfl/${season}/${week}?season_type=${encodeURIComponent(seasonType || 'regular')}`
        ),
    },
    {
      label: 'legacy projection feed',
      fetcher: () => fetchJson(`/stats/nfl/${seasonType}/${season}/${week}?type=projection`),
    },
  ];

  for (const source of queries) {
    try {
      const payload = await source.fetcher();
      const result = normalizeProjectionMap(payload, scoringSettings);
      if (Object.keys(result.projections).length > 0) {
        return result;
      }
    } catch (error) {
      console.warn(`Sleeper+ ${source.label} failed`, { season, week, seasonType, error });
    }
  }

  return { projections: {}, opponents: {} };
};

const fetchWeekStatMap = async ({ season, week, seasonType = 'regular', scoringSettings }) => {
  const path = `/stats/nfl/${seasonType}/${season}/${week}?type=stats`;
  try {
    const payload = await fetchJson(path);
    const result = normalizeStatsMap(payload, scoringSettings);
    if (Object.keys(result.actuals).length > 0) {
      return result;
    }
  } catch (error) {
    console.warn('Sleeper+ weekly stats feed failed', { season, week, seasonType, error });
  }
  return { actuals: {}, opponents: {} };
};

const refreshPlayerDirectory = async ({ force = false } = {}) => {
  const existing = await getCacheEnvelope(STORAGE_KEYS.PLAYERS);
  if (!force && isEnvelopeFresh(existing, PLAYER_DATA_TTL_MS) && existing?.payload?.records) {
    return existing;
  }

  if (!playerDirectoryRefreshPromise) {
    playerDirectoryRefreshPromise = (async () => {
      try {
        const players = await fetchJson('/players/nfl');
        const slimmed = {};
        Object.entries(players || {}).forEach(([playerId, record]) => {
          if (!record) {
            return;
          }
          slimmed[playerId] = slimPlayerRecord(record);
        });

        const payload = {
          lastSync: Date.now(),
          records: slimmed,
        };
        await setCacheEnvelope(STORAGE_KEYS.PLAYERS, payload);
        const updated = await getCacheEnvelope(STORAGE_KEYS.PLAYERS);
        return updated;
      } finally {
        playerDirectoryRefreshPromise = null;
      }
    })();
  }

  return playerDirectoryRefreshPromise;
};

const computePositionRanks = (playerWeekly, playerDirectory) => {
  const byPosition = new Map();
  Object.entries(playerWeekly).forEach(([playerId, weeklyEntries]) => {
    const directoryEntry = playerDirectory[playerId];
    const position = derivePrimaryPosition(directoryEntry);
    const totalPoints = weeklyEntries.reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
    if (!byPosition.has(position)) {
      byPosition.set(position, []);
    }
    byPosition.get(position).push({ playerId, totalPoints });
  });

  const ranks = {};
  byPosition.forEach((entries, position) => {
    entries
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .forEach((entry, index) => {
        ranks[entry.playerId] = {
          position,
          totalPoints: entry.totalPoints,
          rank: index + 1,
        };
      });
  });

  return ranks;
};

const buildOpponentPositionRanks = (projectionResult, playerDirectory) => {
  const totalsByPosition = {};
  const countsByPosition = {};
  const entries = Object.entries(projectionResult?.projections || {});
  entries.forEach(([playerId, projectedPoints]) => {
    const opponent = projectionResult?.opponents?.[playerId];
    const normalizedOpponent = normalizeOpponentCode(opponent);
    if (!normalizedOpponent || !Number.isFinite(projectedPoints)) {
      return;
    }
    const directoryEntry = playerDirectory[playerId];
    if (!directoryEntry) {
      return;
    }
    const position = derivePrimaryPosition(directoryEntry);
    if (!totalsByPosition[position]) {
      totalsByPosition[position] = {};
      countsByPosition[position] = {};
    }
    totalsByPosition[position][normalizedOpponent] =
      (totalsByPosition[position][normalizedOpponent] || 0) + Number(projectedPoints);
    countsByPosition[position][normalizedOpponent] =
      (countsByPosition[position][normalizedOpponent] || 0) + 1;
  });

  return buildOpponentRankMap(totalsByPosition, countsByPosition);
};

const ensureWeeklyRecord = (container, playerId) => {
  if (!container[playerId]) {
    container[playerId] = { actual: {}, projected: {} };
  }
  return container[playerId];
};

const serializeWeeklyContainer = (container) => {
  const serialized = {};
  Object.entries(container).forEach(([playerId, weeklyData]) => {
    const allWeeks = new Set([
      ...Object.keys(weeklyData.actual || {}),
      ...Object.keys(weeklyData.projected || {}),
    ]);
    const entries = Array.from(allWeeks)
      .map((value) => Number(value))
      .sort((a, b) => a - b)
      .map((week) => ({
        week,
        hasActual: Object.prototype.hasOwnProperty.call(weeklyData.actual || {}, week),
        points: Object.prototype.hasOwnProperty.call(weeklyData.actual || {}, week)
          ? Number(weeklyData.actual?.[week]) || 0
          : 0,
        projected:
          Object.prototype.hasOwnProperty.call(weeklyData.projected || {}, week)
            ? Number(weeklyData.projected?.[week])
            : null,
      }));
    serialized[playerId] = entries;
  });
  return serialized;
};

const NFL_REGULAR_SEASON_WEEKS = 18;

const fetchLeagueSnapshot = async (leagueId, playerDirectory, sharedState) => {
  const league = await fetchJson(`/league/${leagueId}`);
  const state = sharedState || (await fetchJson('/state/nfl'));
  const rosters = await fetchJson(`/league/${leagueId}/rosters`);

  const startWeek = Number(league.settings?.start_week) || 1;
  const playoffWeek = Number(league.settings?.playoff_week_start) || 18;
  const leagueSeason = String(league.season || '') || null;
  const stateSeason = String(state.season || state.league_season || '') || null;
  const projectionSeason = leagueSeason || stateSeason;
  const stateWeek = Number(state.display_week ?? state.week) || startWeek;
  const rawStatsWeek = Number(state.week);
  const isSameSeason = !leagueSeason || !stateSeason ? true : leagueSeason === stateSeason;
  const currentWeek = isSameSeason ? Math.min(stateWeek, playoffWeek) : playoffWeek;
  const statsWeek = isSameSeason
    ? Math.max(Math.min(Number.isFinite(rawStatsWeek) ? rawStatsWeek : stateWeek, playoffWeek), startWeek - 1)
    : playoffWeek;
  const seasonType = (isSameSeason ? state.season_type : null) || league.settings?.season_type || 'regular';
  const seasonEndWeek = Math.max(currentWeek, NFL_REGULAR_SEASON_WEEKS);

  const trackedPlayerIds = new Set();
  rosters.forEach((roster) => {
    ['players', 'reserve', 'taxi'].forEach((slot) => {
      (roster[slot] || []).forEach((playerId) => trackedPlayerIds.add(playerId));
    });
  });

  const playerWeeklySource = {};
  const playerMatchupsByWeek = {};
  const matchupRanksByWeek = {};
  const cumulativeOpponentTotals = {};
  const cumulativeOpponentCounts = {};
  let hasOpponentAggregateData = false;

  const recordOpponentSample = (position, opponentCode, points) => {
    if (!Number.isFinite(points)) {
      return;
    }
    if (!cumulativeOpponentTotals[position]) {
      cumulativeOpponentTotals[position] = {};
      cumulativeOpponentCounts[position] = {};
    }
    cumulativeOpponentTotals[position][opponentCode] =
      (cumulativeOpponentTotals[position][opponentCode] || 0) + points;
    cumulativeOpponentCounts[position][opponentCode] =
      (cumulativeOpponentCounts[position][opponentCode] || 0) + 1;
    hasOpponentAggregateData = true;
  };

  for (let week = startWeek; week <= seasonEndWeek; week += 1) {
    if (week !== startWeek) {
      await delay(150);
    }

    const shouldFetchActuals = week <= statsWeek;
    const matchupRequest = shouldFetchActuals
      ? fetchJson(`/league/${leagueId}/matchups/${week}`)
      : Promise.resolve([]);
    const statsRequest = shouldFetchActuals
      ? fetchWeekStatMap({
          season: projectionSeason,
          week,
          seasonType,
          scoringSettings: league.scoring_settings,
        })
      : Promise.resolve({ actuals: {}, opponents: {} });
    const [matchups, projectionMap, statsMap] = await Promise.all([
      matchupRequest,
      fetchWeekProjectionMap({
        season: projectionSeason,
        week,
        seasonType,
        scoringSettings: league.scoring_settings,
      }),
      statsRequest,
    ]);

    if (shouldFetchActuals) {
      matchups.forEach((entry) => {
        const points = entry.players_points || {};
        Object.entries(points).forEach(([playerId, weeklyPoints]) => {
          if (weeklyPoints === undefined || weeklyPoints === null) {
            return;
          }
          const record = ensureWeeklyRecord(playerWeeklySource, playerId);
          const numericPoints = Number(weeklyPoints);
          const safePoints = Number.isFinite(numericPoints) ? numericPoints : 0;
          record.actual[week] = safePoints + (record.actual[week] || 0);
        });
      });
      const statsSource = statsMap && Object.keys(statsMap.actuals || {}).length > 0 ? statsMap : null;
      if (statsSource) {
        Object.entries(statsSource.actuals).forEach(([playerId, weeklyPoints]) => {
          const numericPoints = Number(weeklyPoints);
          if (!Number.isFinite(numericPoints)) {
            return;
          }
          const directoryEntry = playerDirectory[playerId];
          const opponentCode = normalizeOpponentCode(statsSource.opponents?.[playerId]);
          if (!directoryEntry || !opponentCode) {
            return;
          }
          const position = derivePrimaryPosition(directoryEntry);
          recordOpponentSample(position, opponentCode, numericPoints);
        });
      } else {
        matchups.forEach((entry) => {
          const points = entry.players_points || {};
          Object.entries(points).forEach(([playerId, weeklyPoints]) => {
            if (weeklyPoints === undefined || weeklyPoints === null) {
              return;
            }
            const directoryEntry = playerDirectory[playerId];
            const opponentCode = normalizeOpponentCode(projectionMap.opponents?.[playerId]);
            if (!directoryEntry || !opponentCode) {
              return;
            }
            const position = derivePrimaryPosition(directoryEntry);
            const numericPoints = Number(weeklyPoints);
            const safePoints = Number.isFinite(numericPoints) ? numericPoints : 0;
            recordOpponentSample(position, opponentCode, safePoints);
          });
        });
      }
    }

    trackedPlayerIds.forEach((playerId) => {
      if (!(playerId in projectionMap.projections)) {
        return;
      }
      const projectionPoints = projectionMap.projections[playerId];
      if (projectionPoints === null || projectionPoints === undefined) {
        return;
      }
      const record = ensureWeeklyRecord(playerWeeklySource, playerId);
      record.projected[week] = Number(projectionPoints);
    });

    const matchupRanks = hasOpponentAggregateData
      ? buildOpponentRankMap(cumulativeOpponentTotals, cumulativeOpponentCounts)
      : buildOpponentPositionRanks(projectionMap, playerDirectory);
    matchupRanksByWeek[week] = matchupRanks;

    const weekMatchups = {};
    trackedPlayerIds.forEach((playerId) => {
      const opponentRaw =
        statsMap?.opponents?.[playerId] || projectionMap.opponents?.[playerId] || null;
      const normalizedOpponent = normalizeOpponentCode(opponentRaw);
      if (!normalizedOpponent) {
        return;
      }
      const directoryEntry = playerDirectory[playerId];
      if (!directoryEntry) {
        return;
      }
      const position = derivePrimaryPosition(directoryEntry);
      const rankingEntry = matchupRanks[position]?.[normalizedOpponent];
      if (!rankingEntry) {
        return;
      }
      const opponentLabel = opponentRaw ? opponentRaw.toString().toUpperCase() : normalizedOpponent;
      const playerProjection = projectionMap.projections?.[playerId];
      const formattedProjection = Number.isFinite(Number(playerProjection))
        ? Number(Number(playerProjection).toFixed(2))
        : null;
      weekMatchups[playerId] = {
        opponent: opponentLabel,
        position,
        rank: rankingEntry.rank,
        scale: rankingEntry.scale,
        sampleSize: rankingEntry.count,
        projectedAllowed: rankingEntry.total,
        playerProjection: formattedProjection,
      };
    });
    playerMatchupsByWeek[week] = weekMatchups;
  }

  // Ensure rostered players have a container even if no data is available.
  trackedPlayerIds.forEach((playerId) => {
    ensureWeeklyRecord(playerWeeklySource, playerId);
  });

  const playerWeekly = serializeWeeklyContainer(playerWeeklySource);
  const positionRanks = computePositionRanks(playerWeekly, playerDirectory);
  const currentMatchups = playerMatchupsByWeek[currentWeek] || {};
  const currentMatchupRanks = matchupRanksByWeek[currentWeek] || {};
  return {
    leagueId,
    season: league.season,
    startWeek,
    currentWeek,
    displayWeek: stateWeek,
    statsWeek,
    seasonEndWeek,
    playerWeekly,
    positionRanks,
    matchups: currentMatchups,
    matchupRanks: currentMatchupRanks,
    matchupsByWeek: playerMatchupsByWeek,
    matchupRanksByWeek,
  };
};

const buildMetricsSummary = (leagueSnapshots, playerDirectory) => {
  const byLeague = {};
  Object.entries(leagueSnapshots).forEach(([leagueId, snapshot]) => {
    const positions = {};
    Object.entries(snapshot.positionRanks || {}).forEach(([playerId, rankEntry]) => {
      const pos = rankEntry.position;
      if (!positions[pos]) {
        positions[pos] = [];
      }
      positions[pos].push({
        playerId,
        rank: rankEntry.rank,
        totalPoints: rankEntry.totalPoints,
        name: playerDirectory[playerId]?.full_name,
      });
    });

    Object.keys(positions).forEach((pos) => {
      positions[pos]
        .sort((a, b) => a.rank - b.rank)
        .splice(10);
    });

    byLeague[leagueId] = {
      season: snapshot.season,
      startWeek: snapshot.startWeek,
      currentWeek: snapshot.currentWeek,
      positions,
    };
  });

  return { byLeague };
};

const refreshLeagueSnapshots = async ({ force = false, leagueIds } = {}) => {
  const ids = leagueIds && leagueIds.length > 0 ? leagueIds : await getTrackedLeagueIds();
  if (ids.length === 0) {
    return getCacheEnvelope(STORAGE_KEYS.STATS);
  }

  const existing = await getCacheEnvelope(STORAGE_KEYS.STATS);
  const payload = existing?.payload || { lastSync: null, byLeague: {} };
  const isFreshForAll =
    !force &&
    isEnvelopeFresh(existing, LEAGUE_DATA_TTL_MS) &&
    ids.every((leagueId) => Boolean(payload.byLeague?.[leagueId]));
  if (isFreshForAll) {
    return existing;
  }

  const playersEnvelope = await refreshPlayerDirectory({ force: false });
  const playerDirectory = playersEnvelope?.payload?.records || {};
  let state = null;
  try {
    state = await fetchNflState({ force });
  } catch (error) {
    console.warn('Sleeper+ state sync unavailable; using direct snapshot fetch', error);
  }

  const snapshots = { ...payload.byLeague };
  for (const leagueId of ids) {
    try {
      const snapshot = await fetchLeagueSnapshot(leagueId, playerDirectory, state);
      snapshots[leagueId] = snapshot;
    } catch (error) {
      console.error(`Sleeper+ league snapshot failed for ${leagueId}`, error);
    }
  }

  const updatedPayload = {
    lastSync: Date.now(),
    byLeague: snapshots,
  };
  await setCacheEnvelope(STORAGE_KEYS.STATS, updatedPayload);

  const metricsPayload = {
    lastSync: Date.now(),
    summary: buildMetricsSummary(snapshots, playerDirectory),
  };
  await setCacheEnvelope(STORAGE_KEYS.METRICS, metricsPayload);

  await setLastRefreshMetadata({
    source: force ? 'manual' : 'auto',
    leagueCount: ids.length,
  });

  return getCacheEnvelope(STORAGE_KEYS.STATS);
};

const ensurePlayerDirectoryRecords = async () => {
  const envelope = await refreshPlayerDirectory({ force: false });
  return envelope?.payload?.records || {};
};

const ensureLeagueSnapshot = async (leagueId) => {
  if (!leagueId) {
    return null;
  }
  const envelope = await getCacheEnvelope(STORAGE_KEYS.STATS);
  const hasLeague = envelope?.payload?.byLeague?.[leagueId];
  if (hasLeague && isEnvelopeFresh(envelope, LEAGUE_DATA_TTL_MS)) {
    return hasLeague;
  }
  const refreshed = await refreshLeagueSnapshots({ force: true, leagueIds: [leagueId] });
  return refreshed?.payload?.byLeague?.[leagueId] || null;
};

const getPlayerWeeklyEntry = (snapshot, playerId, week) => {
  if (!snapshot || !snapshot.playerWeekly || !playerId || !Number.isFinite(week)) {
    return null;
  }
  const entries = snapshot.playerWeekly[playerId];
  if (!entries || !Array.isArray(entries)) {
    return null;
  }
  return entries.find((entry) => Number(entry.week) === Number(week)) || null;
};

const getPlayerWeekStat = (snapshot, playerId, week, stat) => {
  const entry = getPlayerWeeklyEntry(snapshot, playerId, week);
  if (!entry) {
    return null;
  }
  if (stat === 'actual') {
    return entry.hasActual ? Number(entry.points) || 0 : null;
  }
  if (stat === 'projected') {
    return entry.projected !== undefined && entry.projected !== null ? Number(entry.projected) : null;
  }
  return null;
};

const cleanupMatchupCache = () => {
  const now = Date.now();
  matchupCache.forEach((entry, key) => {
    if (!entry || now - entry.timestamp > MATCHUP_CACHE_TTL_MS) {
      matchupCache.delete(key);
    }
  });
};

const getWeekMatchups = async ({ leagueId, week, force = false }) => {
  const numericWeek = Number(week);
  if (!leagueId || !Number.isFinite(numericWeek)) {
    throw new Error('League and week are required');
  }
  const cacheKey = `${leagueId}:${numericWeek}`;
  if (!force && matchupCache.has(cacheKey)) {
    const cached = matchupCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < MATCHUP_CACHE_TTL_MS) {
      return cached.payload;
    }
  }

  const payload = await fetchJson(`/league/${leagueId}/matchups/${numericWeek}`);
  matchupCache.set(cacheKey, { timestamp: Date.now(), payload });
  cleanupMatchupCache();
  return payload;
};

const computeStarterTotals = (matchupEntry, starterIds, { snapshot, week }) => {
  if (!matchupEntry) {
    return null;
  }
  const starters = sanitizePlayerIdList(
    starterIds && starterIds.length > 0 ? starterIds : matchupEntry.starters || []
  );
  const playerPoints = matchupEntry.players_points || {};
  const playerProjected = matchupEntry.players_projected || {};
  let actualTotal = 0;
  let projectedTotal = 0;

  starters.forEach((playerId) => {
    const actual = Number(playerPoints[playerId]);
    if (Number.isFinite(actual)) {
      actualTotal += actual;
    } else if (snapshot) {
      const fallbackActual = getPlayerWeekStat(snapshot, playerId, week, 'actual');
      if (Number.isFinite(fallbackActual)) {
        actualTotal += fallbackActual;
      }
    }

    const projected = Number(playerProjected[playerId]);
    if (Number.isFinite(projected)) {
      projectedTotal += projected;
    } else if (snapshot) {
      const fallbackProjected = getPlayerWeekStat(snapshot, playerId, week, 'projected');
      if (Number.isFinite(fallbackProjected)) {
        projectedTotal += fallbackProjected;
      }
    }
  });

  const formatTotal = (value) => {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Number(value.toFixed(2));
  };

  return {
    rosterId: matchupEntry.roster_id ?? null,
    matchupId: matchupEntry.matchup_id ?? null,
    starterCount: starters.length,
    starters,
    actual: formatTotal(actualTotal),
    projected: formatTotal(projectedTotal),
  };
};

const getTeamTotalsPayload = async ({ leagueId, rosterId, week, playerIds }) => {
  const normalizedLeagueId = normalizeLeagueId(leagueId);
  const normalizedRosterId = sanitizeRosterId(rosterId);
  const sanitizedPlayers = sanitizePlayerIdList(playerIds);
  try {
    if (!normalizedLeagueId) {
      throw new Error('League unavailable');
    }

    const snapshot = await ensureLeagueSnapshot(normalizedLeagueId);
    if (!snapshot) {
      throw new Error('League data unavailable');
    }

    const resolvedWeek = clampWeekWithinSeason(snapshot, week);
    if (!Number.isFinite(resolvedWeek)) {
      throw new Error('Week unavailable');
    }

    const matchups = await getWeekMatchups({ leagueId: normalizedLeagueId, week: resolvedWeek });
    if (!Array.isArray(matchups) || matchups.length === 0) {
      throw new Error('Matchups unavailable');
    }

    let ourEntry = null;
    if (normalizedRosterId) {
      ourEntry = matchups.find((entry) => String(entry.roster_id) === normalizedRosterId);
    }
    if (!ourEntry && sanitizedPlayers.length > 0) {
      ourEntry =
        matchups.find((entry) => areStarterListsEqual(entry?.starters || [], sanitizedPlayers)) ||
        findBestMatchupByPlayerIds(matchups, sanitizedPlayers);
      if (!ourEntry && matchups.length > 0) {
        console.info('Sleeper+ team totals defaulting to first matchup when roster determination failed');
        ourEntry = matchups[0];
      }
    }
    if (!ourEntry) {
      console.warn('Sleeper+ team totals could not match roster; falling back to first available matchup');
      ourEntry = matchups[0];
    }

    const starters = sanitizedPlayers.length > 0 ? sanitizedPlayers : sanitizePlayerIdList(ourEntry.starters);
    const teamTotals = computeStarterTotals(ourEntry, starters, { snapshot, week: resolvedWeek });

    return {
      leagueId: normalizedLeagueId,
      rosterId: String(ourEntry.roster_id ?? '') || normalizedRosterId,
      week: resolvedWeek,
      generatedAt: Date.now(),
      team: teamTotals,
    };
  } catch (error) {
    console.warn('Sleeper+ team totals failed; returning fallback payload', {
      leagueId: normalizedLeagueId || leagueId,
      rosterId: normalizedRosterId,
      week,
      playerCount: sanitizedPlayers.length,
      error: error?.message || error,
    });
    return {
      leagueId: normalizedLeagueId || leagueId || '',
      rosterId: normalizedRosterId,
      week: Number.isFinite(week) ? Number(week) : null,
      generatedAt: Date.now(),
      team: null,
      error: error?.message || 'Unknown error',
    };
  }
};

const getActiveWeekPayload = async ({ leagueId }) => {
  const normalizedLeagueId = normalizeLeagueId(leagueId);
  if (!normalizedLeagueId) {
    throw new Error('League unavailable');
  }
  const [snapshot, state] = await Promise.all([
    ensureLeagueSnapshot(normalizedLeagueId),
    fetchNflState().catch((error) => {
      console.warn('Sleeper+ state lookup failed for active week', error);
      return null;
    }),
  ]);
  if (!snapshot) {
    throw new Error('League data unavailable');
  }

  const minWeek = Number(snapshot.startWeek) || 1;
  const rawMaxWeek = Number(snapshot.seasonEndWeek) || Number(snapshot.currentWeek) || minWeek;
  const maxWeek = Math.max(rawMaxWeek, minWeek);
  const snapshotWeek = Number(snapshot.currentWeek);
  const statsWeekValue = Number(snapshot.statsWeek);
  const startWeekValue = Number(snapshot.startWeek);
  const displayWeekValue = Number(snapshot.displayWeek);
  const stateWeekCandidate = Number(state?.display_week ?? state?.week ?? state?.leg);
  const resolvedStateWeek = Number.isFinite(stateWeekCandidate)
    ? Math.min(Math.max(stateWeekCandidate, minWeek), maxWeek)
    : null;
  const resolvedWeek = Number.isFinite(resolvedStateWeek)
    ? resolvedStateWeek
    : Number.isFinite(snapshotWeek)
    ? snapshotWeek
    : null;
  const fallbackDisplayWeek = Number.isFinite(displayWeekValue)
    ? displayWeekValue
    : Number.isFinite(snapshotWeek)
    ? snapshotWeek
    : null;

  return {
    leagueId: normalizedLeagueId,
    week: resolvedWeek,
    currentWeek: Number.isFinite(snapshotWeek) ? snapshotWeek : null,
    displayWeek: resolvedWeek ?? fallbackDisplayWeek,
    statsWeek: Number.isFinite(statsWeekValue) ? statsWeekValue : null,
    startWeek: Number.isFinite(startWeekValue) ? startWeekValue : null,
    season: snapshot.season ?? null,
  };
};

const normalizeNameToken = (value) => (value || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');

const findBestPlayerMatch = (directory, query) => {
  if (!directory) {
    return null;
  }

  if (query.playerId && directory[query.playerId]) {
    return { playerId: query.playerId, record: directory[query.playerId] };
  }

  const candidateName = normalizeNameToken(query.fullName || query.displayName || '');
  if (!candidateName) {
    return null;
  }

  let fallbackMatch = null;
  Object.entries(directory).some(([playerId, record]) => {
    const directoryName = normalizeNameToken(record.full_name);
    const searchName = normalizeNameToken(record.search_full_name);
    if (directoryName && directoryName === candidateName) {
      fallbackMatch = { playerId, record };
      return true;
    }
    if (searchName && searchName === candidateName) {
      fallbackMatch = { playerId, record };
      return true;
    }
    if (
      !fallbackMatch &&
      directoryName &&
      candidateName.length > 0 &&
      directoryName.includes(candidateName)
    ) {
      fallbackMatch = { playerId, record };
    }
    return false;
  });

  return fallbackMatch;
};

const buildWeeklySeries = (entries, { startWeek, currentWeek, seasonEndWeek, displayWeek, statsWeek }) => {
  const actualMap = new Map();
  const projectedMap = new Map();
  const actualWeeks = new Set();
  (entries || []).forEach((entry) => {
    const week = Number(entry.week);
    if (!Number.isFinite(week)) {
      return;
    }
    if (entry.hasActual) {
      actualWeeks.add(week);
      actualMap.set(week, Number(entry.points) || 0);
    }
    if (entry.projected !== undefined && entry.projected !== null) {
      projectedMap.set(week, Number(entry.projected));
    }
  });

  const normalizedStartWeek = Number(startWeek) || 1;
  const normalizedCurrentWeek = Number(currentWeek) || normalizedStartWeek;
  const normalizedStatsWeek = Number.isFinite(Number(statsWeek))
    ? Math.max(Number(statsWeek), normalizedStartWeek - 1)
    : normalizedCurrentWeek;
  const normalizedSeasonEnd = Math.max(
    Number(seasonEndWeek) || normalizedCurrentWeek,
    normalizedCurrentWeek
  );
  const requestedWeek = Number(displayWeek);
  const futureMarker = Number.isFinite(requestedWeek)
    ? Math.min(Math.max(requestedWeek, normalizedStartWeek), normalizedSeasonEnd)
    : Math.min(Math.max(normalizedCurrentWeek, normalizedStartWeek), normalizedSeasonEnd);
  const finalWeek = Math.max(normalizedSeasonEnd, futureMarker);

  const series = [];
  for (let week = normalizedStartWeek; week <= finalWeek; week += 1) {
    const hasActual = actualWeeks.has(week) && week <= normalizedStatsWeek;
    const resolvedPoints = hasActual ? actualMap.get(week) ?? 0 : 0;
    series.push({
      week,
      points: resolvedPoints,
      projected: projectedMap.has(week) ? projectedMap.get(week) : null,
      isFuture: week > futureMarker,
      hasActual,
    });
  }
  return series;
};

const clampWeekWithinSeason = (snapshot, requestedWeek) => {
  if (!snapshot) {
    return null;
  }
  const minWeek = Number(snapshot.startWeek) || 1;
  const rawMaxWeek = Number(snapshot.seasonEndWeek) || Number(snapshot.currentWeek) || minWeek;
  const maxWeek = Math.max(rawMaxWeek, minWeek);
  const fallbackWeek = Number(snapshot.currentWeek) || maxWeek;
  const numericRequest = Number(requestedWeek);
  if (Number.isFinite(numericRequest)) {
    return Math.min(Math.max(numericRequest, minWeek), maxWeek);
  }
  return fallbackWeek;
};

const getPlayerTrendPayload = async ({ leagueId, playerId, week, attempt = 0 }) => {
  const [directory, snapshot, state] = await Promise.all([
    ensurePlayerDirectoryRecords(),
    ensureLeagueSnapshot(leagueId),
    fetchNflState().catch((error) => {
      console.warn('Sleeper+ state lookup failed for sparkline context', error);
      return null;
    }),
  ]);

  if (!snapshot) {
    throw new Error('League data is unavailable');
  }

  const hasWeekMaps = snapshot.matchupsByWeek && snapshot.matchupRanksByWeek;
  if (!hasWeekMaps && attempt === 0) {
    await refreshLeagueSnapshots({ force: true, leagueIds: [leagueId] });
    return getPlayerTrendPayload({ leagueId, playerId, week, attempt: 1 });
  }

  const playerRecord = directory[playerId];
  if (!playerRecord) {
    throw new Error('Player metadata missing');
  }

  const selectedWeek = clampWeekWithinSeason(snapshot, week);
  const stateWeekCandidate = Number(state?.display_week ?? state?.week ?? state?.leg);
  const sparklineWeekSource = Number.isFinite(stateWeekCandidate) ? stateWeekCandidate : snapshot.currentWeek;
  const sparklineWeek = clampWeekWithinSeason(snapshot, sparklineWeekSource);
  const weeklyEntries = snapshot.playerWeekly?.[playerId] || [];
  const weeklySeries = buildWeeklySeries(weeklyEntries, {
    startWeek: snapshot.startWeek,
    currentWeek: snapshot.currentWeek,
    seasonEndWeek: snapshot.seasonEndWeek,
    displayWeek: sparklineWeek,
    statsWeek: snapshot.statsWeek,
  });
  const totalPoints = weeklySeries
    .filter((entry) => !entry.isFuture)
    .reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
  const positionRank = snapshot.positionRanks?.[playerId] || null;
  const matchupSource = snapshot.matchupsByWeek?.[selectedWeek] || snapshot.matchups || {};
  const matchup = matchupSource?.[playerId] || null;
  const opponentRanks = snapshot.matchupRanksByWeek?.[selectedWeek] || snapshot.matchupRanks || null;
  const playerTeam = (playerRecord.team || '').toUpperCase();

  if (matchup) {
    console.debug('Sleeper+ matchup payload', {
      leagueId,
      playerId,
      week: selectedWeek,
      opponent: matchup.opponent,
      rank: matchup.rank,
      scale: matchup.scale,
    });
  } else {
    console.info('Sleeper+ matchup missing', {
      leagueId,
      playerId,
      week: selectedWeek,
      matchupKeys: Object.keys(matchupSource || {}),
      hasOpponentRanks: Boolean(opponentRanks),
    });
  }

  return {
    leagueId,
    playerId,
    week: selectedWeek,
    weeklySeries,
    sparklineWeek,
    totalPoints,
    age: playerRecord.age,
    yearsExp: playerRecord.years_exp,
    positionRank,
    matchup,
    opponentRanks,
    primaryPosition: derivePrimaryPosition(playerRecord),
    nflTeam: playerTeam,
  };
};

const scheduleRecurringAlarms = () => {
  const now = Date.now();
  chrome.alarms.create(PLAYER_SNAPSHOT_ALARM, {
    periodInMinutes: 60 * 24,
    when: now + 5 * 60 * 1000,
  });
  chrome.alarms.create(LEAGUE_SNAPSHOT_ALARM, {
    periodInMinutes: 60,
    when: now + 2 * 60 * 1000,
  });
};

const bootstrapCaches = () => {
  refreshPlayerDirectory({ force: false }).catch((error) => {
    console.error('Sleeper+ failed to warm player cache', error);
  });
  refreshLeagueSnapshots({ force: false }).catch((error) => {
    console.error('Sleeper+ failed to warm league cache', error);
  });
};

const extractLeagueIdsFromChange = (change) => {
  if (!change) {
    return [];
  }
  const { newValue } = change;
  if (Array.isArray(newValue)) {
    return sanitizeLeagueIdList(newValue);
  }
  if (newValue === undefined || newValue === null) {
    return [];
  }
  return sanitizeLeagueIdList([String(newValue)]);
};

const respondAsync = (promise, sendResponse, label) => {
  promise
    .then((result) => {
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      console.error(`Sleeper+ ${label} failed`, error);
      sendResponse({ ok: false, error: error.message || 'Unknown error' });
    });
  return true;
};

const openOptionsPage = () => {
  const fallback = () => chrome.runtime.openOptionsPage();
  try {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        fallback();
      }
    });
  } catch (_error) {
    fallback();
  }
};

chrome.runtime.onInstalled.addListener((details) => {
  ensureDefaultStorage().catch((error) => {
    console.error('Sleeper+ failed to initialize storage', error);
  });
  scheduleRecurringAlarms();
  bootstrapCaches();

  if (details.reason === 'install') {
    openOptionsPage();
  }
});

chrome.runtime.onStartup?.addListener(() => {
  ensureDefaultStorage().catch((error) => {
    console.error('Sleeper+ failed to prepare storage on startup', error);
  });
  scheduleRecurringAlarms();
  bootstrapCaches();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  const collected = [];
  if (Object.prototype.hasOwnProperty.call(changes, 'leagueIds')) {
    collected.push(...extractLeagueIdsFromChange(changes.leagueIds));
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'leagueId')) {
    collected.push(...extractLeagueIdsFromChange(changes.leagueId));
  }

  const nextLeagueIds = sanitizeLeagueIdList(collected);
  if (nextLeagueIds.length === 0) {
    return;
  }

  refreshLeagueSnapshots({ force: true, leagueIds: nextLeagueIds }).catch((error) => {
    console.error('Sleeper+ failed to refresh league data after settings change', error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !alarm.name) {
    return;
  }
  if (alarm.name === PLAYER_SNAPSHOT_ALARM) {
    refreshPlayerDirectory({ force: true }).catch((error) => {
      console.error('Sleeper+ scheduled player refresh failed', error);
    });
    return;
  }
  if (alarm.name === LEAGUE_SNAPSHOT_ALARM) {
    refreshLeagueSnapshots({ force: false }).catch((error) => {
      console.error('Sleeper+ scheduled league refresh failed', error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'SLEEPER_PLUS_OPEN_OPTIONS') {
    openOptionsPage();
    if (typeof sendResponse === 'function') {
      sendResponse({ ok: true });
    }
    return false;
  }

  if (message.type === 'SLEEPER_PLUS_GET_PLAYER_DIRECTORY') {
    return respondAsync(
      refreshPlayerDirectory({ force: Boolean(message.force) }).then((envelope) => envelope?.payload || null),
      sendResponse,
      'player directory request'
    );
  }

  if (message.type === 'SLEEPER_PLUS_LOOKUP_PLAYER') {
    return respondAsync(
      ensurePlayerDirectoryRecords().then((directory) => {
        const match = findBestPlayerMatch(directory, message.query || {});
        if (!match) {
          throw new Error('Player not found');
        }
        return match;
      }),
      sendResponse,
      'player lookup'
    );
  }

  if (message.type === 'SLEEPER_PLUS_GET_ACTIVE_WEEK') {
    return respondAsync(
      getActiveWeekPayload({ leagueId: message.leagueId }),
      sendResponse,
      'active week request'
    );
  }

  if (message.type === 'SLEEPER_PLUS_GET_PLAYER_TREND') {
    return respondAsync(
      getPlayerTrendPayload({ leagueId: message.leagueId, playerId: message.playerId, week: message.week }),
      sendResponse,
      'player trend'
    );
  }

  if (message.type === 'SLEEPER_PLUS_GET_TEAM_TOTALS') {
    return respondAsync(
      getTeamTotalsPayload({
        leagueId: message.leagueId,
        rosterId: message.rosterId,
        week: message.week,
        playerIds: message.playerIds,
      }),
      sendResponse,
      'team totals'
    );
  }

  if (message.type === 'SLEEPER_PLUS_FORCE_REFRESH') {
    return respondAsync(
      Promise.all([
        refreshPlayerDirectory({ force: true }),
        refreshLeagueSnapshots({ force: true, leagueIds: message.leagueIds }),
      ]).then(() => ({ done: true })),
      sendResponse,
      'manual refresh'
    );
  }

  return false;
});
