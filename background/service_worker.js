const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const DATA_VERSION = 3;
const STORAGE_KEYS = {
  PLAYERS: 'sleeperPlus:players',
  STATS: 'sleeperPlus:stats',
  METRICS: 'sleeperPlus:metrics',
};

const API_BASE_URL = 'https://api.sleeper.app/v1';
const PROJECTION_API_BASE_URL = 'https://api.sleeper.com';
const PLAYER_SNAPSHOT_ALARM = 'sleeperPlus:refreshPlayers';
const LEAGUE_SNAPSHOT_ALARM = 'sleeperPlus:refreshLeagueStats';
const PLAYER_DATA_TTL_MS = ONE_DAY_MS;
const LEAGUE_DATA_TTL_MS = 3 * ONE_HOUR_MS;

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

const calculateProjectedPoints = (stats, scoringWeights) => {
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
    const projectedPoints = calculateProjectedPoints(stats, scoringWeights);
    const applyPoints = (value) => {
      projections[playerId] = Number(value.toFixed(2));
      if (metadata.opponent) {
        opponents[playerId] = metadata.opponent;
      }
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
    if (metadata.opponent) {
      opponents[playerId] = metadata.opponent;
    }
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

const refreshPlayerDirectory = async ({ force = false } = {}) => {
  const existing = await getCacheEnvelope(STORAGE_KEYS.PLAYERS);
  if (!force && isEnvelopeFresh(existing, PLAYER_DATA_TTL_MS) && existing?.payload?.records) {
    return existing;
  }

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
  return getCacheEnvelope(STORAGE_KEYS.PLAYERS);
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
    if (!opponent || !Number.isFinite(projectedPoints)) {
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
    const normalizedOpponent = opponent.toUpperCase();
    totalsByPosition[position][normalizedOpponent] =
      (totalsByPosition[position][normalizedOpponent] || 0) + Number(projectedPoints);
    countsByPosition[position][normalizedOpponent] =
      (countsByPosition[position][normalizedOpponent] || 0) + 1;
  });

  const ranks = {};
  Object.entries(totalsByPosition).forEach(([position, teamTotals]) => {
    const entriesForPosition = Object.entries(teamTotals)
      .map(([team, total]) => ({
        team,
        total,
        count: countsByPosition[position][team] || 0,
      }))
      .sort((a, b) => b.total - a.total);
    const scale = entriesForPosition.length || 1;
    entriesForPosition.forEach((entry, index) => {
      if (!ranks[position]) {
        ranks[position] = {};
      }
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
        points: Number(weeklyData.actual?.[week]) || 0,
        projected:
          weeklyData.projected?.[week] !== undefined
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
  const isSameSeason = !leagueSeason || !stateSeason ? true : leagueSeason === stateSeason;
  const currentWeek = isSameSeason ? Math.min(stateWeek, playoffWeek) : playoffWeek;
  const seasonType = (isSameSeason ? state.season_type : null) || league.settings?.season_type || 'regular';
  const seasonEndWeek = Math.max(currentWeek, NFL_REGULAR_SEASON_WEEKS);

  const trackedPlayerIds = new Set();
  rosters.forEach((roster) => {
    ['players', 'reserve', 'taxi'].forEach((slot) => {
      (roster[slot] || []).forEach((playerId) => trackedPlayerIds.add(playerId));
    });
  });

  const playerWeeklySource = {};
  const playerMatchups = {};
  let latestMatchupRanks = {};

  for (let week = startWeek; week <= seasonEndWeek; week += 1) {
    if (week !== startWeek) {
      await delay(150);
    }

    const shouldFetchActuals = week <= currentWeek;
    const matchupRequest = shouldFetchActuals
      ? fetchJson(`/league/${leagueId}/matchups/${week}`)
      : Promise.resolve([]);
    const [matchups, projectionMap] = await Promise.all([
      matchupRequest,
      fetchWeekProjectionMap({
        season: projectionSeason,
        week,
        seasonType,
        scoringSettings: league.scoring_settings,
      }),
    ]);

    if (shouldFetchActuals) {
      matchups.forEach((entry) => {
        const points = entry.players_points || {};
        Object.entries(points).forEach(([playerId, weeklyPoints]) => {
          const record = ensureWeeklyRecord(playerWeeklySource, playerId);
          record.actual[week] = (Number(weeklyPoints) || 0) + (record.actual[week] || 0);
        });
      });
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

    if (week === currentWeek) {
      const matchupRanks = buildOpponentPositionRanks(projectionMap, playerDirectory);
      latestMatchupRanks = matchupRanks;
      trackedPlayerIds.forEach((playerId) => {
        const opponent = projectionMap.opponents[playerId];
        if (!opponent) {
          return;
        }
        const directoryEntry = playerDirectory[playerId];
        if (!directoryEntry) {
          return;
        }
        const position = derivePrimaryPosition(directoryEntry);
        const rankingEntry = matchupRanks[position]?.[opponent];
        if (!rankingEntry) {
          return;
        }
        playerMatchups[playerId] = {
          opponent,
          position,
          rank: rankingEntry.rank,
          scale: rankingEntry.scale,
          sampleSize: rankingEntry.count,
          projectedAllowed: rankingEntry.total,
          playerProjection: Number((projectionMap.projections[playerId] || 0).toFixed(2)),
        };
      });
    }
  }

  // Ensure rostered players have a container even if no data is available.
  trackedPlayerIds.forEach((playerId) => {
    ensureWeeklyRecord(playerWeeklySource, playerId);
  });

  const playerWeekly = serializeWeeklyContainer(playerWeeklySource);
  const positionRanks = computePositionRanks(playerWeekly, playerDirectory);
  return {
    leagueId,
    season: league.season,
    startWeek,
    currentWeek,
    seasonEndWeek,
    playerWeekly,
    positionRanks,
    matchups: playerMatchups,
    matchupRanks: latestMatchupRanks,
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
  const state = await fetchJson('/state/nfl');

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

const buildWeeklySeries = (entries, startWeek, currentWeek, seasonEndWeek) => {
  const actualMap = new Map();
  const projectedMap = new Map();
  (entries || []).forEach((entry) => {
    const week = Number(entry.week);
    if (!Number.isFinite(week)) {
      return;
    }
    actualMap.set(week, Number(entry.points) || 0);
    if (entry.projected !== undefined && entry.projected !== null) {
      projectedMap.set(week, Number(entry.projected));
    }
  });

  const series = [];
  const finalWeek = Math.max(currentWeek, Number(seasonEndWeek) || currentWeek);
  for (let week = startWeek; week <= finalWeek; week += 1) {
    series.push({
      week,
      points: actualMap.get(week) ?? 0,
      projected: projectedMap.has(week) ? projectedMap.get(week) : null,
      isFuture: week > currentWeek,
    });
  }
  return series;
};

const getPlayerTrendPayload = async ({ leagueId, playerId }) => {
  const [directory, snapshot] = await Promise.all([
    ensurePlayerDirectoryRecords(),
    ensureLeagueSnapshot(leagueId),
  ]);

  if (!snapshot) {
    throw new Error('League data is unavailable');
  }

  const playerRecord = directory[playerId];
  if (!playerRecord) {
    throw new Error('Player metadata missing');
  }

  const weeklyEntries = snapshot.playerWeekly?.[playerId] || [];
  const weeklySeries = buildWeeklySeries(
    weeklyEntries,
    snapshot.startWeek,
    snapshot.currentWeek,
    snapshot.seasonEndWeek
  );
  const totalPoints = weeklySeries
    .filter((entry) => !entry.isFuture)
    .reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
  const positionRank = snapshot.positionRanks?.[playerId] || null;
  const matchup = snapshot.matchups?.[playerId] || null;
  const opponentRanks = snapshot.matchupRanks || null;

  return {
    leagueId,
    playerId,
    weeklySeries,
    totalPoints,
    age: playerRecord.age,
    yearsExp: playerRecord.years_exp,
    positionRank,
    matchup,
    opponentRanks,
    primaryPosition: derivePrimaryPosition(playerRecord),
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

  if (message.type === 'SLEEPER_PLUS_GET_PLAYER_TREND') {
    return respondAsync(
      getPlayerTrendPayload({ leagueId: message.leagueId, playerId: message.playerId }),
      sendResponse,
      'player trend'
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
