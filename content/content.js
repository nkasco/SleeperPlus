(() => {
  const STYLE_ELEMENT_ID = 'sleeper-plus-layout-style';
  const BUTTON_CONTAINER_ID = 'sleeper-plus-settings-container';
  const SETTINGS_PARENT_CLASS = 'sleeper-plus-settings-parent';
  const BUTTON_CLASS = 'sleeper-plus-settings-button';
  const ENTRY_CLASS = 'sleeper-plus-settings-entry';
  const REFRESH_INDICATOR_ID = 'sleeper-plus-refresh-indicator';
  const REFRESH_INDICATOR_CLASS = 'sleeper-plus-refresh-indicator';
  const REFRESH_INDICATOR_HIDDEN_CLASS = 'is-hidden';
  const REFRESH_INDICATOR_TEXT = 'Refreshing player data for Sleeper+...';
  const TEAM_TOTALS_ERROR_CLASS = 'sleeper-plus-team-totals__error';
  const TEAM_TOTALS_ERROR_TEXT_CLASS = 'sleeper-plus-team-totals__error-text';
  const SETTINGS_OBSERVER_CONFIG = { childList: true, subtree: true };

  const DEFAULT_CHAT_MAX_WIDTH = 400;
  const DEFAULT_SHOW_SETTINGS_BUTTON = true;
  const DEFAULT_DISABLE_SLEEPER_PLUS = false;
  const DEFAULT_ENABLE_TREND_OVERLAYS = true;
  const DEFAULT_SHOW_OPPONENT_RANKS = true;
  const DEFAULT_SHOW_SPARKLINE_ALWAYS = true;
  const DEFAULT_SHOW_TEAM_TOTALS = true;
  const DEFAULT_ENABLE_NAVBAR_OVERRIDE = true;
  const MIN_CHAT_MAX_WIDTH = 200;
  const MAX_CHAT_MAX_WIDTH = 800;
  const CENTER_PANEL_SPARKLINE_THRESHOLD = 800;
  const COMPACT_PANEL_CLASS = 'sleeper-plus-compact-center';

  const DEFAULT_SETTINGS = {
    leagueIds: [],
    chatMaxWidth: DEFAULT_CHAT_MAX_WIDTH,
    showSettingsButton: DEFAULT_SHOW_SETTINGS_BUTTON,
    disableSleeperPlus: DEFAULT_DISABLE_SLEEPER_PLUS,
    enableTrendOverlays: DEFAULT_ENABLE_TREND_OVERLAYS,
    showOpponentRanks: DEFAULT_SHOW_OPPONENT_RANKS,
    showSparklineAlways: DEFAULT_SHOW_SPARKLINE_ALWAYS,
    showTeamTotals: DEFAULT_SHOW_TEAM_TOTALS,
    enableNavbarOverride: DEFAULT_ENABLE_NAVBAR_OVERRIDE,
  };

  let leagueIds = [];
  let chatMaxWidth = DEFAULT_CHAT_MAX_WIDTH;
  let showSettingsButton = DEFAULT_SHOW_SETTINGS_BUTTON;
  let disableSleeperPlus = DEFAULT_DISABLE_SLEEPER_PLUS;
  let enableTrendOverlays = DEFAULT_ENABLE_TREND_OVERLAYS;
  let showOpponentRanks = DEFAULT_SHOW_OPPONENT_RANKS;
  let showSparklineAlways = DEFAULT_SHOW_SPARKLINE_ALWAYS;
  let showTeamTotals = DEFAULT_SHOW_TEAM_TOTALS;
  let enableNavbarOverride = DEFAULT_ENABLE_NAVBAR_OVERRIDE;
  let isActive = false;
  let settingsObserver = null;
  let bodyObserver = null;
  let currentBaseUrl = '';
  let centerPanelResizeObserver = null;
  let observedCenterPanel = null;
  let centerPanelWatchIntervalId = null;
  let windowResizeListenerAttached = false;
  let pendingCenterPanelResizeFrame = null;
  let isCenterPanelCompact = false;
  let headerSettingsParent = null;

  const activeWeekService = (() => {
    const CACHE_TTL_MS = 60 * 1000;
    const cache = new Map();
    const inflight = new Map();

    const fetchWeek = (leagueId) => {
      const normalized = typeof leagueId === 'string' ? leagueId.trim() : '';
      if (!normalized) {
        return Promise.resolve(null);
      }
      const cached = cache.get(normalized);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return Promise.resolve(cached.value);
      }
      if (inflight.has(normalized)) {
        return inflight.get(normalized);
      }
      const request = sendRuntimeMessage(
        { type: 'SLEEPER_PLUS_GET_ACTIVE_WEEK', leagueId: normalized },
        'active week'
      )
        .then((result) => {
          const candidates = [result?.week, result?.displayWeek, result?.currentWeek, result?.statsWeek];
          let resolved = null;
          for (let index = 0; index < candidates.length; index += 1) {
            const numeric = Number(candidates[index]);
            if (Number.isFinite(numeric) && numeric >= 1) {
              resolved = numeric;
              break;
            }
          }
          cache.set(normalized, { value: resolved, timestamp: Date.now() });
          inflight.delete(normalized);
          return resolved;
        })
        .catch((error) => {
          inflight.delete(normalized);
          console.debug('Sleeper+ active week request failed', error);
          return null;
        });
      inflight.set(normalized, request);
      return request;
    };

    return { fetchWeek };
  })();

  const sanitizeChatWidth = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_CHAT_MAX_WIDTH;
    }

    const rounded = Math.round(numeric);
    if (rounded < MIN_CHAT_MAX_WIDTH) {
      return MIN_CHAT_MAX_WIDTH;
    }
    if (rounded > MAX_CHAT_MAX_WIDTH) {
      return MAX_CHAT_MAX_WIDTH;
    }
    return rounded;
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

  const sanitizeLeagueIds = (value) => {
    const collected = [];
    const pushValue = (entry) => {
      const normalized = normalizeLeagueId(entry);
      if (normalized && !collected.includes(normalized)) {
        collected.push(normalized);
      }
    };

    if (Array.isArray(value)) {
      value.forEach(pushValue);
    } else if (value) {
      pushValue(String(value));
    }

    return collected;
  };

  const areLeagueListsEqual = (first, second) => {
    if (first.length !== second.length) {
      return false;
    }
    return first.every((value, index) => value === second[index]);
  };

  const sanitizeSettings = (rawSettings) => {
    const raw = rawSettings || {};
    const leagueCandidates = raw.leagueIds ?? raw.leagueId ?? [];
    return {
      leagueIds: sanitizeLeagueIds(leagueCandidates),
      chatMaxWidth:
        raw.chatMaxWidth !== undefined
          ? sanitizeChatWidth(raw.chatMaxWidth)
          : DEFAULT_SETTINGS.chatMaxWidth,
      showSettingsButton:
        typeof raw.showSettingsButton === 'boolean'
          ? raw.showSettingsButton
          : DEFAULT_SETTINGS.showSettingsButton,
      disableSleeperPlus:
        typeof raw.disableSleeperPlus === 'boolean'
          ? raw.disableSleeperPlus
          : DEFAULT_SETTINGS.disableSleeperPlus,
      enableTrendOverlays:
        typeof raw.enableTrendOverlays === 'boolean'
          ? raw.enableTrendOverlays
          : DEFAULT_SETTINGS.enableTrendOverlays,
      showOpponentRanks:
        typeof raw.showOpponentRanks === 'boolean'
          ? raw.showOpponentRanks
          : DEFAULT_SETTINGS.showOpponentRanks,
      showSparklineAlways:
        typeof raw.showSparklineAlways === 'boolean'
          ? raw.showSparklineAlways
          : DEFAULT_SETTINGS.showSparklineAlways,
      showTeamTotals:
        typeof raw.showTeamTotals === 'boolean'
          ? raw.showTeamTotals
          : DEFAULT_SETTINGS.showTeamTotals,
      enableNavbarOverride:
        typeof raw.enableNavbarOverride === 'boolean'
          ? raw.enableNavbarOverride
          : DEFAULT_SETTINGS.enableNavbarOverride,
    };
  };

  const getStoredSettings = () => {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        [
          'leagueIds',
          'leagueId',
          'chatMaxWidth',
          'showSettingsButton',
          'disableSleeperPlus',
          'enableTrendOverlays',
          'showOpponentRanks',
          'showSparklineAlways',
          'showTeamTotals',
          'enableNavbarOverride',
        ],
        (result) => resolve(sanitizeSettings(result))
      );
    });
  };

  const isLeaguePath = () => window.location.pathname.startsWith('/leagues/');

  const doesUrlMatchLeague = () => {
    if (leagueIds.length === 0) {
      return false;
    }

    if (!isLeaguePath()) {
      return false;
    }

    const href = window.location.href;
    return leagueIds.some((id) => href.startsWith(`https://sleeper.com/leagues/${id}`));
  };

  const getCurrentLeagueId = () => {
    if (!isLeaguePath()) {
      return '';
    }
    const match = window.location.pathname.match(/\/leagues\/([^/]+)/i);
    return match && match[1] ? match[1] : '';
  };

  const TEAM_PATH_PATTERN = /\/leagues\/[^/]+\/team(?:\/\d+)?(?:\/?|$)/i;

  const extractRosterIdToken = (value) => {
    if (value === null || value === undefined) {
      return '';
    }
    const normalized = String(value).trim();
    if (!normalized) {
      return '';
    }
    const numeric = normalized.replace(/[^0-9]/g, '');
    return numeric || '';
  };

  const getRosterIdFromSearch = () => {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const keys = ['team', 'teamId', 'team_id', 'roster', 'rosterId', 'roster_id'];
      for (let index = 0; index < keys.length; index += 1) {
        const value = params.get(keys[index]);
        const token = extractRosterIdToken(value);
        if (token) {
          return token;
        }
      }
    } catch (_error) {
      // ignore
    }
    return '';
  };

  const getRosterIdFromHash = () => {
    const hash = window.location.hash || '';
    if (!hash) {
      return '';
    }
    const match = hash.match(/(?:team|roster)[^0-9]{0,4}(\d{1,4})/i);
    return match && match[1] ? match[1] : '';
  };

  const getRosterIdFromDom = () => {
    const selectors = [
      '.team-roster[data-roster-id]',
      '.team-roster[data-team-id]',
      '.team-roster [data-roster-id]',
      '.team-roster [data-team-id]',
      '.user-card[data-roster-id]',
      '.user-card [data-roster-id]',
    ];
    const attributeTokens = ['roster', 'team'];
    for (let index = 0; index < selectors.length; index += 1) {
      const element = document.querySelector(selectors[index]);
      if (!element) {
        continue;
      }
      const attributes = typeof element.getAttributeNames === 'function' ? element.getAttributeNames() : [];
      for (let attrIndex = 0; attrIndex < attributes.length; attrIndex += 1) {
        const name = attributes[attrIndex];
        if (!name) {
          continue;
        }
        const lowered = name.toLowerCase();
        if (!attributeTokens.some((token) => lowered.includes(token))) {
          continue;
        }
        const token = extractRosterIdToken(element.getAttribute(name));
        if (token) {
          return token;
        }
      }
      const dataset = element.dataset || {};
      const datasetKeys = Object.keys(dataset);
      for (let keyIndex = 0; keyIndex < datasetKeys.length; keyIndex += 1) {
        const key = datasetKeys[keyIndex];
        if (!key) {
          continue;
        }
        const lowered = key.toLowerCase();
        if (!attributeTokens.some((token) => lowered.includes(token))) {
          continue;
        }
        const token = extractRosterIdToken(dataset[key]);
        if (token) {
          return token;
        }
      }
    }
    return '';
  };

  const getCurrentRosterId = () => {
    if (!isLeaguePath()) {
      return '';
    }
    const pathMatch = window.location.pathname.match(/\/team\/(\d+)/i);
    if (pathMatch && pathMatch[1]) {
      return pathMatch[1];
    }
    const queryMatch = getRosterIdFromSearch();
    if (queryMatch) {
      return queryMatch;
    }
    const hashMatch = getRosterIdFromHash();
    if (hashMatch) {
      return hashMatch;
    }
    const domMatch = getRosterIdFromDom();
    if (domMatch) {
      return domMatch;
    }
    return '';
  };

  const isTeamView = () => TEAM_PATH_PATTERN.test(window.location.pathname || '');

  const sendRuntimeMessage = (message, label) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error(`${label} failed`));
            return;
          }
          if (!response.ok) {
            reject(new Error(response.error || `${label} failed`));
            return;
          }
          resolve(response.result);
        });
      } catch (error) {
        reject(error);
      }
    });

  const openSleeperPlusSettings = () => {
    const fallback = () => {
      chrome.runtime.sendMessage({ type: 'SLEEPER_PLUS_OPEN_OPTIONS' });
    };

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

  const shouldDisplaySettingsButton = () => disableSleeperPlus || showSettingsButton;

  const refreshIndicatorController = (() => {
    let indicatorNode = null;
    let desiredActive = false;

    const syncIndicatorState = () => {
      if (!indicatorNode) {
        return;
      }
      if (desiredActive) {
        indicatorNode.classList.remove(REFRESH_INDICATOR_HIDDEN_CLASS);
      } else {
        indicatorNode.classList.add(REFRESH_INDICATOR_HIDDEN_CLASS);
      }
    };

    const resolveIndicatorPlacement = () => {
      // Prefer placing the indicator immediately above the starters/meta text when available
      const meta = document.querySelector('.sleeper-plus-team-totals__meta');
      if (meta && meta.isConnected && meta.parentElement) {
        return { parent: meta.parentElement, before: meta, requiresSettingsButton: false };
      }

      const totalsError = document.querySelector(`.${TEAM_TOTALS_ERROR_CLASS}`);
      if (totalsError && totalsError.isConnected) {
        const errorText = totalsError.querySelector(`.${TEAM_TOTALS_ERROR_TEXT_CLASS}`);
        return { parent: totalsError, before: errorText || null, requiresSettingsButton: false };
      }
      const buttonContainer = document.getElementById(BUTTON_CONTAINER_ID);
      if (!buttonContainer) {
        return null;
      }
      const placement = buttonContainer.dataset.placement || '';
      if (placement === 'actions') {
        return null;
      }
      if (!buttonContainer.parentElement) {
        return null;
      }
      return { parent: buttonContainer.parentElement, before: buttonContainer, requiresSettingsButton: true };
    };

    const ensureIndicatorNode = () => {
      const placement = resolveIndicatorPlacement();
      if (!placement || !placement.parent || (placement.requiresSettingsButton && !shouldDisplaySettingsButton())) {
        if (indicatorNode && indicatorNode.parentElement) {
          indicatorNode.parentElement.removeChild(indicatorNode);
        }
        indicatorNode = null;
        return null;
      }
      if (indicatorNode && !indicatorNode.isConnected) {
        indicatorNode = null;
      }
      if (!indicatorNode) {
        indicatorNode = document.createElement('div');
        indicatorNode.id = REFRESH_INDICATOR_ID;
        indicatorNode.className = `${ENTRY_CLASS} ${REFRESH_INDICATOR_CLASS} ${REFRESH_INDICATOR_HIDDEN_CLASS}`;
        indicatorNode.textContent = REFRESH_INDICATOR_TEXT;
      }
      if (placement.before) {
        if (indicatorNode.parentElement !== placement.parent || indicatorNode.nextElementSibling !== placement.before) {
          placement.parent.insertBefore(indicatorNode, placement.before);
        }
      } else if (indicatorNode.parentElement !== placement.parent || indicatorNode.nextElementSibling) {
        placement.parent.appendChild(indicatorNode);
      }
      syncIndicatorState();
      return indicatorNode;
    };

    const setActive = (nextActive) => {
      const normalized = !!nextActive;
      if (desiredActive === normalized && indicatorNode) {
        syncIndicatorState();
        return;
      }
      desiredActive = normalized;
      const node = ensureIndicatorNode();
      if (!node) {
        return;
      }
      syncIndicatorState();
    };

    const remove = () => {
      if (indicatorNode && indicatorNode.parentElement) {
        indicatorNode.parentElement.removeChild(indicatorNode);
      }
      indicatorNode = null;
      desiredActive = false;
    };

    return { setActive, remove };
  })();

  const ensureStyleElement = () => {
    let style = document.getElementById(STYLE_ELEMENT_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ELEMENT_ID;
      document.head.appendChild(style);
    }
    return style;
  };

  const getButtonStyleBlock = () => `
      .${SETTINGS_PARENT_CLASS} {
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 12px !important;
        flex-wrap: wrap;
      }
      #${BUTTON_CONTAINER_ID} {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        padding: 0;
        gap: 9px;
        min-width: 72px;
      }
      #${BUTTON_CONTAINER_ID}.${ENTRY_CLASS} {
        padding: 0;
      }
      #${BUTTON_CONTAINER_ID}[data-placement='actions'] {
        margin: 0;
      }
      #${BUTTON_CONTAINER_ID}[data-placement='header'] {
        border: none;
        background: transparent;
        margin: 0;
      }
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.08), rgba(15, 23, 42, 0.6));
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 12px 22px rgba(2, 6, 23, 0.55);
        padding: 0;
        transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0;
        transition: color 0.15s ease;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:focus-visible {
        outline: none;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS} svg {
        width: 18px;
        height: 18px;
      }
      .sleeper-plus-settings-label {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        font-size: 0.62rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.78);
      }
      .${REFRESH_INDICATOR_CLASS} {
        font-size: 0.78rem;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.8);
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        min-height: 20px;
      }
      #${BUTTON_CONTAINER_ID}[data-placement='actions'] .${REFRESH_INDICATOR_CLASS} {
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        justify-content: center;
      }
      .${REFRESH_INDICATOR_CLASS}.${REFRESH_INDICATOR_HIDDEN_CLASS} {
        display: none !important;
      }
      /* Harmonize team roster item alternating backgrounds with page theme */
      .team-roster-item {
        margin: 6px 6px !important;
        border-radius: 12px !important;
        border: 1px solid rgba(120, 180, 255, 0.12) !important;
        background-clip: padding-box;
      }
      .team-roster-item.odd {
        background: rgba(24,28,40,0.28) !important;
        border-color: rgba(120, 180, 255, 0.18) !important;
      }
      .team-roster-item.even {
        background: rgba(31,36,49,0.12) !important;
      }
      .team-roster-item.out {
        background: rgba(200,50,90,0.025) !important;
        border-color: rgba(239, 68, 68, 0.35) !important;
      }
      /* Selected player state follows the extension's deep-navy/neon accent theme */
      .team-roster-item.selected.valid {
        background: linear-gradient(132deg, rgba(24,38,64,0.96) 0%, rgba(31,73,112,0.92) 55%, rgba(24,137,171,0.88) 100%) !important;
        border-color: rgba(123, 195, 255, 0.65) !important;
        box-shadow: 0 12px 32px rgba(5, 8, 20, 0.55), inset 0 0 20px rgba(126, 235, 255, 0.28) !important;
        color: inherit;
      }
      .team-roster-item.selected.valid .link-button.cell-position {
        background: transparent !important;
        border-color: transparent !important;
        box-shadow: none !important;
      }
      .team-roster-item.selected.valid .league-slot-position-square {
        background: linear-gradient(135deg, rgba(8,16,32,0.95) 0%, rgba(17,44,78,0.95) 60%, rgba(23,137,178,0.9) 100%) !important;
        border-radius: 14px !important;
        border: 1px solid rgba(123, 195, 255, 0.4) !important;
        box-shadow: inset 0 0 12px rgba(19,113,167,0.35), 0 4px 12px rgba(5, 8, 20, 0.65) !important;
      }
      .team-roster-item.selected.valid .league-slot-position-square > div {
        color: #e8f7ff !important;
        letter-spacing: 0.04em;
      }
    `;

  const getNavbarStyleBlock = () => `
      /* Center tab selector styling — Option E (sleek neon pill) */
      .center-tab-selector {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: 16px;
        background: linear-gradient(120deg, rgba(28,38,54,0.92) 0%, rgba(44,62,80,0.88) 100%);
        border: 1px solid rgba(120, 180, 255, 0.08);
      }
      .center-tab-selector .item-tab {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 18px;
        border-radius: 999px;
        cursor: pointer;
        color: rgba(236, 242, 255, 0.78);
        background: rgba(255, 255, 255, 0.01);
        border: 1px solid transparent;
        transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), color 200ms ease, background 200ms ease, border-color 200ms ease;
      }
      .center-tab-selector .item-tab::after {
        content: '';
        position: absolute;
        inset: 2px;
        border-radius: inherit;
        border: 1px solid rgba(255, 255, 255, 0.04);
        opacity: 0;
        transition: opacity 200ms ease;
      }
      .center-tab-selector .item-tab:hover {
        transform: translateY(-1px);
        color: #eaf6ff;
        border-color: rgba(123, 195, 255, 0.12);
        background: linear-gradient(110deg, #2a3956 0%, #2e4a5e 100%);
        box-shadow: 0 4px 12px rgba(0,0,0,0.18);
      }
      .center-tab-selector .item-tab:hover::after {
        opacity: 1;
      }
      .center-tab-selector .item-tab.selected {
        color: #1a2e3a;
        background: linear-gradient(110deg, #b3d8ff 0%, #bafff2 100%);
        border-color: rgba(123, 195, 255, 0.18);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
        text-shadow: 0 1px 8px rgba(255,255,255,0.18);
      }
      .center-tab-selector .item-tab.selected::after {
        opacity: 0;
      }
      .center-tab-selector .item-tab:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(123, 195, 255, 0.35);
      }
      .center-tab-selector .item-tab svg {
        width: 13px;
        height: 13px;
        flex: 0 0 13px;
        color: inherit;
        opacity: 0.7;
        transition: opacity 200ms ease;
      }
      .center-tab-selector .item-tab:hover svg,
      .center-tab-selector .item-tab.selected svg {
        opacity: 1;
      }
      .center-tab-selector .item-tab svg,
      .center-tab-selector .item-tab svg * {
        stroke: currentColor !important;
        fill: currentColor !important;
        color: currentColor !important;
        stroke-width: 1 !important;
      }
      .center-tab-selector .selector-title {
        font-size: 0.78rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        font-weight: 600;
        color: inherit;
      }
    `;

  const getTrendStyleBlock = () => `
      .sleeper-plus-trend-row {
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: 8px;
      }
      .sleeper-plus-trend {
        margin-left: auto;
        display: inline-flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        font-size: 0.82rem;
        line-height: 1.2;
        color: inherit;
        min-width: 320px;
        max-width: 100%;
      }
      .sleeper-plus-trend__stack {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-left: 12px;
        border-left: 1px solid rgba(255, 255, 255, 0.25);
        white-space: normal;
      }
      .sleeper-plus-trend__meta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
      }
      .sleeper-plus-trend__meta-item {
        display: flex;
        gap: 3px;
        align-items: baseline;
      }
      .sleeper-plus-trend__meta-label {
        opacity: 0.7;
        text-transform: uppercase;
        font-size: 0.7rem;
        letter-spacing: 0.05em;
      }
      .sleeper-plus-trend__chart {
        flex: 0 0 auto;
        min-height: 36px;
        text-align: right;
        width: 100%;
      }
      .sleeper-plus-trend__chart > svg {
        flex: 0 0 16px;
        width: 100%;
        height: 48px;
      }
      .sleeper-plus-trend__chart svg {
        background: transparent;
      }
      .sleeper-plus-trend__chart svg polygon {
        fill: rgba(255, 255, 255, 0.035) !important;
      }
      .sleeper-plus-trend__chart .sleeper-plus-line {
        fill: none;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .sleeper-plus-trend__chart .sleeper-plus-line.line-over {
        stroke: #22c55e;
      }
      .sleeper-plus-trend__chart .sleeper-plus-line.line-under {
        stroke: #e35a5a;
      }
      .sleeper-plus-user-tab-row {
        align-items: stretch;
        flex-wrap: wrap;
        gap: 16px;
      }
      .sleeper-plus-team-totals {
        flex: 0 0 auto;
        width: 700px;
        max-width: 100%;
        margin: 6px auto 2px;
        padding: 13px 22px 10px;
        border-radius: 24px;
        border: 1px solid rgba(120, 180, 255, 0.08);
        background: linear-gradient(120deg, rgba(28,38,54,0.80) 0%, rgba(44,62,80,0.65) 100%);
        box-shadow: 0 24px 45px rgba(2, 6, 23, 0.5);
        display: flex;
        flex-direction: column;
        gap: 9px;
        min-width: 0;
        max-width: none;
        font-size: 0.76rem;
        align-self: center;
        position: relative;
        overflow: hidden;
        box-sizing: border-box;
      }
      .sleeper-plus-team-totals__shell {
        display: flex;
        flex-direction: column;
        gap: 18px;
        align-items: stretch;
      }
      .sleeper-plus-team-totals__identity {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        flex: 1 1 auto;
        width: 100%;
        min-width: 0;
        flex-wrap: wrap;
      }
      .sleeper-plus-team-totals__identity-slot {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
      }
      .sleeper-plus-team-totals__identity-slot > * {
        width: auto;
        min-width: 0;
      }
      .sleeper-plus-team-totals__identity .sleeper-plus-team-totals__heading,
      .sleeper-plus-team-totals__identity .sleeper-plus-team-totals__heading-row,
      .sleeper-plus-team-totals__identity .sleeper-plus-team-totals__stats,
      .sleeper-plus-team-totals__identity .sleeper-plus-team-totals__meta {
        width: auto;
        min-width: 0;
      }
      .sleeper-plus-team-totals__stats {
        display: flex;
        flex-wrap: wrap;
        gap: 18px;
        flex: 0 0 auto;
        min-width: 0;
        justify-content: flex-end;
        align-items: flex-start;
        margin-left: auto;
        text-align: right;
      }
      
      .sleeper-plus-team-totals__identity--hidden {
        display: none;
      }
      .sleeper-plus-team-totals__identity-row {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
      }
      .sleeper-plus-team-totals__identity-row .avatar {
        flex: 0 0 45px;
        width: 45px;
        height: 45px;
        border-radius: 50%;
        overflow: hidden;
        box-shadow: 0 6px 16px rgba(2, 6, 23, 0.65);
        border: 1px solid rgba(255,255,255,0.06);
        background-clip: padding-box;
      }
      .sleeper-plus-team-totals__identity-row .info {
        flex: 1 1 auto;
        min-width: 0;
      }
      .sleeper-plus-team-totals__identity-row .name-row {
        font-size: 1.18rem;
        font-weight: 700;
        gap: 8px;
      }
      .sleeper-plus-team-totals__identity-row .name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sleeper-plus-team-totals__identity-row .info .name-row + * {
        font-size: 0.9rem;
        opacity: 0.8;
      }
      .sleeper-plus-team-totals__content {
        display: flex;
        flex-direction: column;
        width: 100%;
        gap: 20px;
      }
      .sleeper-plus-team-totals__stack {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 0px;
      }
      .sleeper-plus-team-totals.is-hidden {
        display: none !important;
      }
      .sleeper-plus-team-totals__heading-row {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        justify-content: flex-end;
        gap: 18px;
        flex-wrap: nowrap;
        margin-bottom: 0;
        width: auto;
        flex: 0 0 auto;
        margin-left: auto;
      }
      .sleeper-plus-team-totals__heading-cluster {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        min-width: 0;
      }
      .sleeper-plus-team-totals__heading {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        justify-content: center;
        gap: 4px;
        text-transform: uppercase;
        flex: 0 0 auto;
        min-width: 0;
        text-align: right;
      }
      .sleeper-plus-team-totals__header {
        font-size: 1rem;
        letter-spacing: 0.18em;
        opacity: 0.78;
      }
      .sleeper-plus-team-totals__week {
        font-weight: 600;
        font-size: 0.78rem;
        letter-spacing: 0.14em;
        color: rgba(255, 255, 255, 0.75);
      }
      .sleeper-plus-team-totals__body {
        display: flex;
        flex-wrap: wrap;
        width: 100%;
        gap: 24px;
        justify-content: space-between;
        align-items: flex-start;
      }
      .sleeper-plus-team-totals__footer {
        display: flex;
        flex-direction: row;
        align-items: flex-end;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        width: 100%;
      }
      .sleeper-plus-team-totals__footer-left {
        flex: 1 1 260px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }
      .sleeper-plus-team-totals__footer-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: flex-end;
        justify-content: flex-end;
        width: auto;
        min-width: 0;
      }
      .sleeper-plus-team-totals__actions {
        display: flex;
        justify-content: flex-end;
        align-items: flex-end;
        flex-wrap: wrap;
        gap: 12px;
        flex: 0 0 auto;
        margin-left: auto;
        width: auto;
        margin-top: 0;
      }
      .sleeper-plus-team-totals__actions--hidden {
        display: none;
      }
      .sleeper-plus-team-totals__row {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        min-width: 120px;
        gap: 4px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .sleeper-plus-team-totals__label {
        opacity: 0.7;
        text-transform: uppercase;
        font-size: 0.72rem;
        letter-spacing: 0.2em;
        text-align: right;
      }
      .sleeper-plus-team-totals__value {
        font-weight: 650;
        font-size: 1.7rem;
        line-height: 1;
        text-align: right;
      }
      .sleeper-plus-team-totals__row[data-variant='actual'] .sleeper-plus-team-totals__value {
        color: #34d399;
      }
      .sleeper-plus-team-totals__row[data-variant='projected'] .sleeper-plus-team-totals__value {
        color: #60a5fa;
      }
      .sleeper-plus-team-totals__actions-row {
        display: inline-flex;
        align-items: flex-end;
        justify-content: flex-end;
        gap: 16px;
        margin: 0;
        width: auto;
        flex-wrap: nowrap;
      }
      .sleeper-plus-team-totals__actions-row .btn-container,
      .sleeper-plus-team-totals__actions-row .btns {
        margin: 0;
        gap: 16px;
        display: inline-flex;
        flex-wrap: nowrap;
        align-items: flex-end;
      }
      .sleeper-plus-team-totals__actions-row .action,
      .sleeper-plus-team-totals__actions-row .btn-container > div {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        text-align: center;
        font-size: 0.66rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.75);
      }
      .sleeper-plus-team-totals__actions-row button,
      .sleeper-plus-team-totals__actions-row .button,
      .sleeper-plus-team-totals__actions-row .btn {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.08), rgba(15, 23, 42, 0.6));
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 12px 22px rgba(2, 6, 23, 0.55);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .sleeper-plus-team-totals__actions-row button svg,
      .sleeper-plus-team-totals__actions-row .button svg,
      .sleeper-plus-team-totals__actions-row .btn svg {
        width: 20px;
        height: 20px;
      }
      .sleeper-plus-team-totals__actions-row button:hover,
      .sleeper-plus-team-totals__actions-row .button:hover,
      .sleeper-plus-team-totals__actions-row .btn:hover,
      .sleeper-plus-team-totals__actions-row button:focus-visible,
      .sleeper-plus-team-totals__actions-row .button:focus-visible,
      .sleeper-plus-team-totals__actions-row .btn:focus-visible {
        border-color: rgba(255, 255, 255, 0.5);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 16px 28px rgba(2, 6, 23, 0.7);
        transform: translateY(-2px);
      }
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:hover,
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:focus-within {
        border-color: rgba(255, 255, 255, 0.5);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 16px 28px rgba(2, 6, 23, 0.7);
        transform: translateY(-2px);
      }
      .sleeper-plus-team-totals__meta {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.66rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.65);
        opacity: 0.9;
        white-space: nowrap;
        justify-content: flex-end;
        text-align: right;
        width: auto;
        min-width: 0;
        margin-left: 12px;
      }
      .sleeper-plus-team-totals__error {
        font-size: 0.75rem;
        color: #fca5a5;
        min-height: 18px;
        transition: opacity 0.15s ease;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        margin-left: 0;
        text-align: left;
        flex: 0 0 auto;
        white-space: normal;
        width: 100%;
      }
      .sleeper-plus-team-totals__error-text {
        font-size: 0.75rem;
        color: #fca5a5;
      }
      .sleeper-plus-team-totals__error .${REFRESH_INDICATOR_CLASS} {
        font-size: 0.68rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.85);
      }
      .sleeper-plus-team-totals__row {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        min-width: 120px;
        gap: 4px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .sleeper-plus-team-totals__spinner {
        position: absolute;
        inset: 0;
        font-size: 0.72rem;
        letter-spacing: 0.18em;
        transform: translateX(-100%);
        opacity: 0;
        transition: opacity 0.2s ease;
        font-size: 1.9rem;
        line-height: 1;
        text-align: left;
        animation: sleeper-plus-shimmer 1.4s linear infinite;
      }
        display: inline-flex;
        align-items: center;
        gap: 16px;
        margin: 0;
        width: auto;
        flex-wrap: nowrap;
          transform: translateX(-100%);
        }
        to {
          transform: translateX(100%);
        }
      }
      .sleeper-plus-trend__chart .sleeper-plus-line.line-neutral {
        stroke: #3b82f6;
      }
      .sleeper-plus-trend__chart .sleeper-plus-line.line-future {
        stroke: #94a3b8;
        stroke-width: 2;
        stroke-dasharray: 4 3;
      }
      .sleeper-plus-trend__chart .sleeper-plus-projection-line {
        stroke: #0d9488;
        stroke-width: 1.5;
        stroke-dasharray: 4 3;
        fill: none;
      }
      .sleeper-plus-trend__chart .sleeper-plus-dot {
        stroke: #0f172a;
        stroke-width: 1;
      }
      .sleeper-plus-trend__chart .sleeper-plus-dot.over {
        fill: #22c55e;
      }
      .sleeper-plus-trend__chart .sleeper-plus-dot.under {
        fill: #e35a5a;
      }
      .sleeper-plus-trend__chart .sleeper-plus-dot.neutral {
        fill: #3b82f6;
      }
      .sleeper-plus-trend__chart .sleeper-plus-dot.future {
        fill: #94a3b8;
        stroke: #1f2937;
      }
      .sleeper-plus-matchup {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        padding: 6px 10px;
        border-radius: 6px;
        background: rgba(14, 165, 233, 0.15);
        border: 1px solid rgba(14, 165, 233, 0.4);
        min-width: 140px;
      }
      .sleeper-plus-matchup__label {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.8);
      }
      .sleeper-plus-matchup__value {
        font-weight: 600;
        font-size: 0.9rem;
        color: #fff;
      }
      .sleeper-plus-matchup.matchup-good {
        background: rgba(34, 197, 94, 0.18);
        border-color: rgba(34, 197, 94, 0.5);
      }
      .sleeper-plus-matchup.matchup-neutral {
        background: rgba(59, 130, 246, 0.15);
        border-color: rgba(59, 130, 246, 0.45);
      }
      .sleeper-plus-matchup.matchup-bad {
        background: rgba(239, 68, 68, 0.18);
        border-color: rgba(239, 68, 68, 0.5);
      }
      .sleeper-plus-matchup-inline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 8px;
        padding: 2px 10px;
        border-radius: 999px;
        border: 1px solid rgba(14, 165, 233, 0.4);
        background: rgba(14, 165, 233, 0.15);
        font-size: 0.75rem;
        line-height: 1.2;
        white-space: nowrap;
      }
      .sleeper-plus-matchup-inline .sleeper-plus-matchup__label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        opacity: 0.85;
      }
      .sleeper-plus-matchup-inline .sleeper-plus-matchup__value {
        font-size: 0.85rem;
        font-weight: 600;
      }
      .sleeper-plus-matchup-inline.matchup-good {
        background: rgba(34, 197, 94, 0.18);
        border-color: rgba(34, 197, 94, 0.5);
      }
      .sleeper-plus-matchup-inline.matchup-neutral {
        background: rgba(59, 130, 246, 0.15);
        border-color: rgba(59, 130, 246, 0.45);
      }
      .sleeper-plus-matchup-inline.matchup-bad {
        background: rgba(239, 68, 68, 0.18);
        border-color: rgba(239, 68, 68, 0.5);
      }
      .sleeper-plus-matchup-inline.placeholder {
        background: rgba(148, 163, 184, 0.16);
        border-color: rgba(148, 163, 184, 0.4);
        color: rgba(226, 232, 240, 0.85);
      }
      .sleeper-plus-matchup-inline.placeholder .sleeper-plus-matchup__label {
        opacity: 0.7;
      }
      .sleeper-plus-matchup-inline.placeholder .sleeper-plus-matchup__value {
        opacity: 0.85;
      }
      .sleeper-plus-trend__error {
        font-size: 0.78rem;
        opacity: 0.75;
      }
    `;

  const removeStyles = () => {
    const existing = document.getElementById(STYLE_ELEMENT_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  };

  const applyButtonOnlyStyles = () => {
    if (!shouldDisplaySettingsButton()) {
      removeStyles();
      return;
    }

    const style = ensureStyleElement();
    const navbarStyles = enableNavbarOverride ? getNavbarStyleBlock() : '';
    style.textContent = `${getButtonStyleBlock()}${navbarStyles}`;
  };

  const updateLayoutStyles = () => {
    const widthPx = `${chatMaxWidth}px`;
    const style = ensureStyleElement();

    const layoutStyles = `
      .center-panel {
        flex-grow: 1 !important;
        flex-shrink: 1 !important;
        flex-basis: auto !important;
        width: auto !important;
        min-width: unset !important;
        max-width: unset !important;
      }
      .right-panel {
        width: ${widthPx} !important;
        min-width: ${widthPx} !important;
        max-width: ${widthPx} !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
        flex-basis: ${widthPx} !important;
      }
    `;

    const shouldRenderButtonStyles = shouldDisplaySettingsButton();
    const buttonStyles = shouldRenderButtonStyles ? getButtonStyleBlock() : '';
    const navbarStyles =
      shouldRenderButtonStyles && enableNavbarOverride ? getNavbarStyleBlock() : '';
    const trendStyles = getTrendStyleBlock();
    const compactStyles = `.${COMPACT_PANEL_CLASS} .sleeper-plus-trend__chart,
        .${COMPACT_PANEL_CLASS} .sleeper-plus-trend__meta {
          display: none !important;
        }
        .${COMPACT_PANEL_CLASS} .sleeper-plus-trend-row {
          display: block !important;
          gap: 0 !important;
        }
        .${COMPACT_PANEL_CLASS} .sleeper-plus-trend {
          margin-left: 0 !important;
          min-width: 0 !important;
          max-width: 100% !important;
        }
        .${COMPACT_PANEL_CLASS} .sleeper-plus-trend__stack {
          padding-left: 0 !important;
          border-left: none !important;
        }`;

    style.textContent = `${layoutStyles}${buttonStyles}${navbarStyles}${trendStyles}${compactStyles}`;
  };

  const setCompactCenterPanelState = (shouldCompact) => {
    if (isCenterPanelCompact === shouldCompact) {
      return;
    }
    isCenterPanelCompact = shouldCompact;
    if (!document.documentElement) {
      return;
    }
    document.documentElement.classList.toggle(COMPACT_PANEL_CLASS, shouldCompact);
  };

  const getCenterPanelWidth = (panel) => {
    if (!panel) {
      return 0;
    }
    const rect = panel.getBoundingClientRect();
    if (rect && typeof rect.width === 'number') {
      return rect.width;
    }
    return panel.offsetWidth || 0;
  };

  const evaluateCenterPanelWidth = (panel = observedCenterPanel) => {
    if (!isActive || !panel) {
      setCompactCenterPanelState(false);
      return;
    }
    const width = getCenterPanelWidth(panel);
    const shouldCompact =
      Number.isFinite(width) && width > 0 && width < CENTER_PANEL_SPARKLINE_THRESHOLD;
    setCompactCenterPanelState(shouldCompact);
  };

  const handleCenterPanelResize = (entries) => {
    if (!isActive) {
      return;
    }
    entries.forEach((entry) => {
      if (entry.target === observedCenterPanel) {
        evaluateCenterPanelWidth(entry.target);
      }
    });
  };

  const ensureCenterPanelObserver = () => {
    if (!centerPanelResizeObserver && typeof ResizeObserver === 'function') {
      centerPanelResizeObserver = new ResizeObserver(handleCenterPanelResize);
    }
    return centerPanelResizeObserver;
  };

  const disconnectCenterPanelObserver = () => {
    if (centerPanelResizeObserver && observedCenterPanel) {
      centerPanelResizeObserver.unobserve(observedCenterPanel);
    }
    observedCenterPanel = null;
  };

  const watchCenterPanel = () => {
    if (!isActive) {
      return;
    }
    const panel = document.querySelector('.center-panel');
    if (!panel) {
      disconnectCenterPanelObserver();
      setCompactCenterPanelState(false);
      return;
    }
    if (panel === observedCenterPanel) {
      evaluateCenterPanelWidth(panel);
      return;
    }
    disconnectCenterPanelObserver();
    const observer = ensureCenterPanelObserver();
    if (observer) {
      observer.observe(panel);
    }
    observedCenterPanel = panel;
    evaluateCenterPanelWidth(panel);
  };

  const handleWindowResize = () => {
    if (pendingCenterPanelResizeFrame) {
      return;
    }
    pendingCenterPanelResizeFrame = window.requestAnimationFrame(() => {
      pendingCenterPanelResizeFrame = null;
      if (!isActive) {
        setCompactCenterPanelState(false);
        return;
      }
      if (observedCenterPanel) {
        evaluateCenterPanelWidth(observedCenterPanel);
      } else {
        watchCenterPanel();
      }
    });
  };

  const attachCenterPanelResizeListener = () => {
    if (!windowResizeListenerAttached) {
      window.addEventListener('resize', handleWindowResize);
      windowResizeListenerAttached = true;
    }
  };

  const detachCenterPanelResizeListener = () => {
    if (windowResizeListenerAttached) {
      window.removeEventListener('resize', handleWindowResize);
      windowResizeListenerAttached = false;
    }
    if (pendingCenterPanelResizeFrame) {
      window.cancelAnimationFrame(pendingCenterPanelResizeFrame);
      pendingCenterPanelResizeFrame = null;
    }
  };

  const startCenterPanelMonitor = () => {
    if (!isActive) {
      return;
    }
    attachCenterPanelResizeListener();
    watchCenterPanel();
    if (!centerPanelWatchIntervalId) {
      centerPanelWatchIntervalId = window.setInterval(() => watchCenterPanel(), 1500);
    }
  };

  const stopCenterPanelMonitor = () => {
    if (centerPanelWatchIntervalId) {
      window.clearInterval(centerPanelWatchIntervalId);
      centerPanelWatchIntervalId = null;
    }
    detachCenterPanelResizeListener();
    disconnectCenterPanelObserver();
    setCompactCenterPanelState(false);
  };

  const trendOverlayManager = (() => {
    const CONTAINER_CLASS = 'sleeper-plus-trend';
    const ERROR_CLASS = 'sleeper-plus-trend__error';
    const META_CLASS = 'sleeper-plus-trend__meta';
    const STACK_CLASS = 'sleeper-plus-trend__stack';
    const META_ITEM_CLASS = 'sleeper-plus-trend__meta-item';
    const META_LABEL_CLASS = 'sleeper-plus-trend__meta-label';
    const META_VALUE_CLASS = 'sleeper-plus-trend__meta-value';
    const CHART_CLASS = 'sleeper-plus-trend__chart';
    const MATCHUP_CLASS = 'sleeper-plus-matchup';
    const MATCHUP_INLINE_CLASS = 'sleeper-plus-matchup-inline';
    const MATCHUP_LABEL_CLASS = 'sleeper-plus-matchup__label';
    const MATCHUP_VALUE_CLASS = 'sleeper-plus-matchup__value';
    const SCHEDULE_WRAPPER_SELECTORS = [
      '.game-schedule-live-description',
      '.game-schedule-wrapper',
      '.player-game-info',
      '.matchup-info',
      '.player-matchup',
      '.matchup-row',
      '.game-schedule',
      '.player-game-status',
      '.game-status',
      '.game-status-wrapper',
      '.bye-week',
    ];
    const SCHEDULE_KEYWORDS = ['schedule', 'matchup', 'game', 'bye', 'status'];
    const SCHEDULE_DATA_ATTRIBUTES = ['data-testid', 'data-test', 'data-qa'];
    const SCHEDULE_REHYDRATION_SELECTOR = SCHEDULE_WRAPPER_SELECTORS.join(',');
    let inlineMatchupState = new WeakMap();
    const NFL_TEAM_CODES = [
      'ARI',
      'ATL',
      'BAL',
      'BUF',
      'CAR',
      'CHI',
      'CIN',
      'CLE',
      'DAL',
      'DEN',
      'DET',
      'GB',
      'HOU',
      'IND',
      'JAX',
      'JAC',
      'KC',
      'LAC',
      'LAR',
      'LA',
      'LV',
      'MIA',
      'MIN',
      'NE',
      'NO',
      'NYG',
      'NYJ',
      'PHI',
      'PIT',
      'SEA',
      'SF',
      'TB',
      'TEN',
      'WAS',
      'WSH',
    ];
    const TEAM_CODE_SET = new Set(NFL_TEAM_CODES);
    const TEAM_CODE_ALIASES = {
      JAC: 'JAX',
      WSH: 'WAS',
    };
    const normalizeTeamAbbr = (value) =>
      (value || '')
        .toString()
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
    const canonicalizeTeamCode = (value) => {
      const normalized = normalizeTeamAbbr(value);
      if (!normalized) {
        return '';
      }
      return TEAM_CODE_ALIASES[normalized] || normalized;
    };
    const isKnownTeamCode = (value) => {
      const normalized = normalizeTeamAbbr(value);
      return normalized ? TEAM_CODE_SET.has(normalized) : false;
    };

    const normalizeScheduleText = (wrapper) =>
      (wrapper?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const DATASET_PLAYER_ID = 'sleeperPlusPlayerId';
    const DATASET_STATE = 'sleeperPlusTrendState';
    const DATASET_WEEK = 'sleeperPlusWeek';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const WEEK_POLL_INTERVAL_MS = 1200;

    const processingMap = new WeakMap();
    const trendCache = new Map();
    const sparklineCache = new Map();
    const sparklineSourceCache = new Map();
    const inflightTrends = new Map();
    const lookupCache = new Map();
    const inflightLookups = new Map();
    const MODAL_CLASS_PATTERN = /(modal|dialog|overlay|sheet|drawer|portal)/i;
    const MODAL_ID_TOKENS = ['modal', 'dialog', 'overlay', 'portal', 'sheet', 'drawer'];
    const MODAL_ATTRIBUTE_TOKENS = ['modal', 'dialog', 'overlay'];

    let leagueId = '';
    let running = false;
    let activeWeek = null;
    let rosterObserver = null;
    let observedRoster = null;
    let rosterWatchInterval = null;
    let scanScheduled = false;
    let visibilityListenerAttached = false;
    let weekPollIntervalId = null;
    let pendingTrendRequests = 0;

    const updateRefreshIndicator = () => {
      refreshIndicatorController.setActive(running && pendingTrendRequests > 0);
    };

    const normalizeNameToken = (value) =>
      (value || '')
        .toString()
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    const isLeagueStandingsView = () =>
      /\/leagues\/[^/]+\/league(?:\/|$)/i.test(window.location.pathname || '');

    const hasModalAncestor = (node) => {
      const target = node?.closest?.('.team-roster');
      if (!target) {
        return false;
      }
      let current = target.parentElement;
      while (current && current !== document.body) {
        const role = current.getAttribute?.('role') || '';
        const ariaModal = current.getAttribute?.('aria-modal');
        if (role === 'dialog' || role === 'alertdialog' || ariaModal === 'true') {
          return true;
        }
        const classMatches = Array.from(current.classList || []).some((className) =>
          MODAL_CLASS_PATTERN.test(className)
        );
        if (classMatches) {
          return true;
        }
        const id = current.id || '';
        if (id && MODAL_ID_TOKENS.some((token) => id.toLowerCase().includes(token))) {
          return true;
        }
        const attributeHit = MODAL_ATTRIBUTE_TOKENS.some((token) => {
          const attributeNames = ['data-testid', 'data-test', 'data-qa'];
          return attributeNames.some((attr) => {
            const value = current.getAttribute?.(attr);
            return value ? value.toLowerCase().includes(token) : false;
          });
        });
        if (attributeHit) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };

    const isOverlayRoster = (item) => isLeagueStandingsView() && hasModalAncestor(item);

    const getCurrentWeekNumber = () => (Number.isFinite(activeWeek) ? activeWeek : null);
    const getCurrentWeekKey = () => (Number.isFinite(activeWeek) ? `week-${activeWeek}` : 'auto');
    const buildTrendCacheKey = (playerId, weekKey) => {
      const resolvedWeekKey = weekKey || getCurrentWeekKey();
      return `${leagueId}:${resolvedWeekKey}:${playerId}`;
    };

    const resolvePlayerId = async (identity) => {
      if (identity.playerId) {
        return identity.playerId;
      }
      const normalized = normalizeNameToken(identity.fullName);
      if (!normalized) {
        return '';
      }
      if (lookupCache.has(normalized)) {
        return lookupCache.get(normalized) || '';
      }
      if (inflightLookups.has(normalized)) {
        return inflightLookups.get(normalized);
      }
      const request = sendRuntimeMessage(
        { type: 'SLEEPER_PLUS_LOOKUP_PLAYER', query: { fullName: identity.fullName } },
        'player lookup'
      )
        .then((result) => {
          const playerId = result?.playerId || '';
          lookupCache.set(normalized, playerId);
          inflightLookups.delete(normalized);
          return playerId;
        })
        .catch((error) => {
          inflightLookups.delete(normalized);
          throw error;
        });

      inflightLookups.set(normalized, request);
      return request;
    };

    const buildSparklineSourceSignature = (series = []) =>
      series
        .map((entry = {}) => {
          const week = entry.week ?? '';
          const actual = Number(entry.points) || 0;
          const projected =
            entry.projected === null || entry.projected === undefined ? 'null' : Number(entry.projected) || 0;
          const hasActual = entry.hasActual ? '1' : '0';
          const isFuture = entry.isFuture ? '1' : '0';
          const isDisplayed = entry.isDisplayedWeek ? '1' : '0';
          return `${week}:${actual}:${projected}:${hasActual}:${isFuture}:${isDisplayed}`;
        })
        .join('|');

    const stabilizeSparklineSeries = (playerId, trendPayload) => {
      if (!playerId || !trendPayload) {
        return trendPayload;
      }
      const normalizedWeek = Number.isFinite(Number(trendPayload.sparklineWeek))
        ? Number(trendPayload.sparklineWeek)
        : null;
      const normalizedSeries = Array.isArray(trendPayload.weeklySeries) ? trendPayload.weeklySeries : [];
      const signature = buildSparklineSourceSignature(normalizedSeries);
      const cached = sparklineSourceCache.get(playerId);
      const shouldUpdateCache =
        !cached ||
        cached.signature !== signature ||
        (Number.isFinite(normalizedWeek) && Number.isFinite(cached?.week) && normalizedWeek > cached.week);
      if (shouldUpdateCache) {
        sparklineSourceCache.set(playerId, {
          week: normalizedWeek,
          series: normalizedSeries,
          signature,
        });
        return { ...trendPayload, weeklySeries: normalizedSeries, sparklineWeek: normalizedWeek };
      }
      return {
        ...trendPayload,
        weeklySeries: cached.series,
        sparklineWeek: cached.week,
      };
    };

    const fetchTrendData = async (playerId, weekContext = {}) => {
      const weekKey = weekContext.cacheKey || getCurrentWeekKey();
      const cacheKey = buildTrendCacheKey(playerId, weekKey);
      if (trendCache.has(cacheKey)) {
        return trendCache.get(cacheKey);
      }
      if (inflightTrends.has(cacheKey)) {
        return inflightTrends.get(cacheKey);
      }

      const payload = { type: 'SLEEPER_PLUS_GET_PLAYER_TREND', leagueId, playerId };
      const requestedWeek = Number.isFinite(weekContext.weekNumber)
        ? weekContext.weekNumber
        : getCurrentWeekNumber();
      if (Number.isFinite(requestedWeek)) {
        payload.week = requestedWeek;
      }

      pendingTrendRequests += 1;
      updateRefreshIndicator();

      const request = sendRuntimeMessage(payload, 'trend request')
        .then((result) => {
          const stabilizedResult = stabilizeSparklineSeries(playerId, result);
          inflightTrends.delete(cacheKey);
          trendCache.set(cacheKey, stabilizedResult);
          return stabilizedResult;
        })
        .catch((error) => {
          inflightTrends.delete(cacheKey);
          throw error;
        })
        .finally(() => {
          pendingTrendRequests = Math.max(0, pendingTrendRequests - 1);
          updateRefreshIndicator();
        });

      inflightTrends.set(cacheKey, request);
      return request;
    };

    const removeTrend = (item) => {
      if (!item) {
        return;
      }
      const existing = item.querySelectorAll(`.${CONTAINER_CLASS}`);
      existing.forEach((node) => node.remove());
      item.querySelectorAll(`.${MATCHUP_INLINE_CLASS}`).forEach((node) => node.remove());
      delete item.dataset[DATASET_PLAYER_ID];
      delete item.dataset[DATASET_STATE];
      delete item.dataset[DATASET_WEEK];
      inlineMatchupState.delete(item);
    };

    const cleanupAll = () => {
      document
        .querySelectorAll(`.${CONTAINER_CLASS}`)
        .forEach((node) => node.parentElement?.removeChild(node));
      document
        .querySelectorAll(`.${MATCHUP_INLINE_CLASS}`)
        .forEach((node) => node.parentElement?.removeChild(node));
      document.querySelectorAll('.team-roster-item').forEach((item) => {
        delete item.dataset[DATASET_PLAYER_ID];
        delete item.dataset[DATASET_STATE];
        delete item.dataset[DATASET_WEEK];
        inlineMatchupState.delete(item);
      });
      inlineMatchupState = new WeakMap();
    };

    const setItemWeekKey = (item, weekKey) => {
      if (!item) {
        return;
      }
      if (weekKey) {
        item.dataset[DATASET_WEEK] = weekKey;
      } else {
        delete item.dataset[DATASET_WEEK];
      }
    };

    const extractIdentity = (item) => {
      const avatar = item.querySelector('.avatar-player[aria-label]');
      const ariaLabel = avatar?.getAttribute('aria-label') || '';
      const idMatch = ariaLabel.match(/player\s+(\d+)/i);
      const playerId = idMatch ? idMatch[1] : '';
      const name = item.querySelector('.player-name')?.textContent?.trim() || '';
      return { playerId, fullName: name };
    };

    const createMetaItem = (label, value, { title } = {}) => {
      if (!value && value !== 0) {
        return null;
      }
      const wrapper = document.createElement('span');
      wrapper.className = META_ITEM_CLASS;
      if (title) {
        wrapper.title = title;
      }

      const labelEl = document.createElement('span');
      labelEl.className = META_LABEL_CLASS;
      labelEl.textContent = label;
      wrapper.appendChild(labelEl);

      const valueEl = document.createElement('span');
      valueEl.className = META_VALUE_CLASS;
      valueEl.textContent = value;
      wrapper.appendChild(valueEl);

      return wrapper;
    };

    const isByeMatchup = (matchup) => {
      const opponent = (matchup?.opponent || '').toString().trim().toLowerCase();
      if (!opponent) {
        return false;
      }
      return opponent === 'bye' || opponent === 'bye week';
    };

    const formatOrdinal = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return '';
      }
      const normalized = Math.abs(Math.trunc(numeric));
      if (normalized === 0) {
        return '';
      }
      const remainder = normalized % 100;
      if (remainder >= 11 && remainder <= 13) {
        return `${normalized}th`;
      }
      const lastDigit = normalized % 10;
      if (lastDigit === 1) {
        return `${normalized}st`;
      }
      if (lastDigit === 2) {
        return `${normalized}nd`;
      }
      if (lastDigit === 3) {
        return `${normalized}rd`;
      }
      return `${normalized}th`;
    };

    const getRankDescriptor = (rank, scale) => {
      const rankValue = Number(rank);
      if (!Number.isFinite(rankValue) || rankValue <= 0) {
        return null;
      }
      const normalizedScale = Number(scale);
      const scaleValue = Number.isFinite(normalizedScale) && normalizedScale > 0 ? normalizedScale : 32;
      const midpoint = Math.ceil(scaleValue / 2);
      return rankValue <= midpoint ? 'most' : 'fewest';
    };

    const isMidTierRank = (rank) => {
      const rankValue = Number(rank);
      if (!Number.isFinite(rankValue)) {
        return false;
      }
      return rankValue >= 10 && rankValue <= 20;
    };

    const buildMatchupTooltip = (matchup) => {
      if (!matchup) {
        return '';
      }
      const opponentLabel = (matchup.opponent || '').toString().trim();
      const positionLabel = (matchup.position || '').toString().trim();
      const rankValue = Number(matchup.rank);
      if (!opponentLabel || !positionLabel || !Number.isFinite(rankValue)) {
        return '';
      }
      const descriptor = getRankDescriptor(rankValue, matchup.scale);
      const ordinal = formatOrdinal(rankValue);
      if (!descriptor || !ordinal) {
        return '';
      }
      return `${opponentLabel} gives up the ${ordinal} ${descriptor} points to the ${positionLabel.toUpperCase()} position.`;
    };

    const getMatchupToneClass = (rank, scale) => {
      const rankValue = Number(rank);
      if (!Number.isFinite(rankValue)) {
        return 'matchup-neutral';
      }
      if (isMidTierRank(rankValue)) {
        return 'matchup-neutral';
      }
      const descriptor = getRankDescriptor(rankValue, scale);
      if (descriptor === 'most') {
        return 'matchup-good';
      }
      if (descriptor === 'fewest') {
        return 'matchup-bad';
      }
      return 'matchup-neutral';
    };

    const createMatchupNode = (matchup, { inline = false } = {}) => {
      if (
        !matchup ||
        matchup.rank === null ||
        matchup.rank === undefined ||
        !matchup.opponent ||
        !matchup.position ||
        isByeMatchup(matchup)
      ) {
        return null;
      }
      const wrapper = document.createElement('div');
      wrapper.className = inline ? MATCHUP_INLINE_CLASS : MATCHUP_CLASS;
      const rankValue = Number(matchup.rank);
      const toneClass = getMatchupToneClass(rankValue, matchup.scale || 32);
      if (toneClass) {
        wrapper.classList.add(toneClass);
      }
      const projectedAllowed = Number(matchup.projectedAllowed);
      const matchupTooltip = buildMatchupTooltip(matchup);
      if (matchupTooltip) {
        wrapper.title = matchupTooltip;
      } else if (Number.isFinite(projectedAllowed)) {
        const sampleText = matchup.sampleSize ? ` across ${matchup.sampleSize} player projections` : '';
        wrapper.title = `${matchup.position} vs ${matchup.opponent} projects to ${projectedAllowed.toFixed(1)} pts${sampleText}`;
      }

      const label = document.createElement('span');
      label.className = MATCHUP_LABEL_CLASS;
      label.textContent = '';
      label.hidden = true;
      wrapper.appendChild(label);

      const value = document.createElement('span');
      value.className = MATCHUP_VALUE_CLASS;
      const scale = Number(matchup.scale) || 32;
      if (Number.isFinite(rankValue)) {
        value.textContent = `#${rankValue}/${scale}`;
      } else {
        value.textContent = 'Rank —';
      }
      wrapper.appendChild(value);

      return wrapper;
    };

    const isWithinNameRow = (node) => Boolean(node?.closest?.('.player-name-row'));

    const findScheduleWrapper = (item) => {
      if (!item) {
        return null;
      }
      for (let index = 0; index < SCHEDULE_WRAPPER_SELECTORS.length; index += 1) {
        const node = item.querySelector(SCHEDULE_WRAPPER_SELECTORS[index]);
        if (node && !isWithinNameRow(node)) {
          return node;
        }
      }
      const meta = item.querySelector('.cell-player-meta');
      if (!meta) {
        return null;
      }
      const keywordMatches = (value = '') =>
        SCHEDULE_KEYWORDS.some((keyword) => value.toLowerCase().includes(keyword));
      const attributeMatches = (element) => {
        if (!(element instanceof Element)) {
          return false;
        }
        return SCHEDULE_DATA_ATTRIBUTES.some((attribute) => {
          const attrValue = element.getAttribute(attribute);
          return attrValue ? keywordMatches(attrValue) : false;
        });
      };

      const children = Array.from(meta.children || []);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!(child instanceof Element)) {
          continue;
        }
        if (isWithinNameRow(child)) {
          continue;
        }
        const classNames = Array.from(child.classList || []);
        if (classNames.some((className) => keywordMatches(className))) {
          return child;
        }
        if (attributeMatches(child)) {
          return child;
        }
        const nestedSchedule = child.querySelector('.game-schedule-live-description');
        if (nestedSchedule && !isWithinNameRow(nestedSchedule)) {
          return nestedSchedule;
        }
      }
      const firstEligible = children.find((child) => child instanceof Element && !isWithinNameRow(child));
      if (firstEligible) {
        return firstEligible;
      }
      const byeNode = item.querySelector('.player-name-row .bye-week');
      if (byeNode) {
        return byeNode;
      }
      return meta;
    };

    const findWeatherNode = (wrapper) => {
      if (!wrapper) {
        return null;
      }
      const selectors = ['[class*="weather"]', '[data-testid*="weather"]', '[data-test*="weather"]'];
      for (let index = 0; index < selectors.length; index += 1) {
        const node = wrapper.querySelector(selectors[index]);
        if (node) {
          return node;
        }
      }
      const children = Array.from(wrapper.children || []);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (
          child instanceof Element &&
          Array.from(child.classList || []).some((className) => className.toLowerCase().includes('weather'))
        ) {
          return child;
        }
      }
      return null;
    };

    const resolveTrendHost = (scheduleWrapper, item) => {
      if (!item) {
        return null;
      }
      const rowCandidate = scheduleWrapper?.closest?.('.row') || null;
      const rowAncestor = rowCandidate && !rowCandidate.closest('.player-name-row') ? rowCandidate : null;
      if (rowAncestor) {
        return rowAncestor;
      }
      if (scheduleWrapper?.parentElement && !isWithinNameRow(scheduleWrapper.parentElement)) {
        return scheduleWrapper.parentElement;
      }
      if (scheduleWrapper && !isWithinNameRow(scheduleWrapper)) {
        return scheduleWrapper;
      }
      const meta = item.querySelector('.cell-player-meta');
      if (meta) {
        return meta;
      }
      return item;
    };

    const stripInlineMatchupNodes = (wrapper) => {
      if (!wrapper || typeof wrapper.cloneNode !== 'function') {
        return null;
      }
      const clone = wrapper.cloneNode(true);
      clone.querySelectorAll(`.${MATCHUP_INLINE_CLASS}`).forEach((node) => node.remove());
      return clone;
    };

    const extractOpponentCode = (wrapper, playerTeam) => {
      if (!wrapper) {
        return '';
      }
      const sanitizedWrapper = stripInlineMatchupNodes(wrapper) || wrapper;
      const text = sanitizedWrapper.textContent || '';
      if (!text) {
        return '';
      }
      const normalized = text.replace(/\s+/g, ' ').toUpperCase();
      if (normalized.includes('BYE')) {
        return '';
      }
      const playerCode = canonicalizeTeamCode(playerTeam);

      const directMatch = normalized.match(/(?:VS\.?|V\.?|AT|@)\s*([A-Z]{2,4})\b/);
      if (directMatch && directMatch[1]) {
        const candidate = canonicalizeTeamCode(directMatch[1]);
        if (candidate && isKnownTeamCode(candidate)) {
          return candidate;
        }
      }

      const duelMatch = normalized.match(/\b([A-Z]{2,4})\b\s*(?:VS\.?|V\.?|AT|@)\s*\b([A-Z]{2,4})\b/);
      if (duelMatch) {
        const first = canonicalizeTeamCode(duelMatch[1]);
        const second = canonicalizeTeamCode(duelMatch[2]);
        if (playerCode && first === playerCode && second && isKnownTeamCode(second)) {
          return second;
        }
        if (playerCode && second === playerCode && first && isKnownTeamCode(first)) {
          return first;
        }
        if (second && isKnownTeamCode(second)) {
          return second;
        }
      }

      const tokens = [];
      const tokenPattern = /\b([A-Z]{2,4})\b/g;
      let match;
      while ((match = tokenPattern.exec(normalized))) {
        const token = canonicalizeTeamCode(match[1]);
        if (token && isKnownTeamCode(token) && !tokens.includes(token)) {
          tokens.push(token);
        }
      }

      if (tokens.length === 0) {
        return '';
      }

      if (playerCode) {
        const opponentToken = tokens.find((token) => token !== playerCode);
        if (opponentToken) {
          return opponentToken;
        }
        if (tokens.length === 1 && tokens[0] === playerCode) {
          return '';
        }
      }

      return tokens[tokens.length - 1];
    };

    const buildFallbackMatchup = (data, item, scheduleWrapper) => {
      if (!data?.opponentRanks) {
        return null;
      }
      const hostWrapper = scheduleWrapper || findScheduleWrapper(item);
      const normalizedScheduleText = normalizeScheduleText(hostWrapper);
      const positionHints = [
        data.matchup?.position,
        data.positionRank?.position,
        data.primaryPosition,
      ]
        .map((value) => (value || '').toString().toUpperCase())
        .filter((value, index, array) => value && value !== 'UNK' && array.indexOf(value) === index);
      const opponentCode = extractOpponentCode(hostWrapper, data?.nflTeam || data?.team);
      const isByeOpponent = !opponentCode && normalizedScheduleText?.includes('bye');
      if (!opponentCode) {
        if (isByeOpponent) {
          const fallbackPosition = positionHints[0] || 'UNK';
          return {
            opponent: 'bye',
            position: fallbackPosition,
            rank: null,
            scale: data.matchup?.scale || 32,
            sampleSize: 0,
            projectedAllowed: null,
            playerProjection: 0,
            derived: true,
          };
        }
        console.debug('Sleeper+ fallback matchup missing opponent code', {
          playerId: data?.playerId || item?.dataset?.[DATASET_PLAYER_ID] || null,
          primaryPosition: data.primaryPosition,
          playerTeam: data?.nflTeam || data?.team || null,
        });
        return null;
      }
      const normalizedOpponent = opponentCode.toUpperCase().replace(/[^A-Z]/g, '');
      if (!normalizedOpponent) {
        return null;
      }

      const ranksByPosition = data.opponentRanks || {};
      const findEntry = () => {
        for (let index = 0; index < positionHints.length; index += 1) {
          const hint = positionHints[index];
          const table = ranksByPosition[hint] || ranksByPosition[hint.toUpperCase?.()];
          if (!table) {
            continue;
          }
          const entry =
            table[normalizedOpponent] ||
            table[normalizedOpponent.replace(/^@/, '')] ||
            table[`@${normalizedOpponent}`];
          if (entry) {
            return { table, position: hint, entry };
          }
        }
        const allPositions = Object.keys(ranksByPosition || {});
        for (let index = 0; index < allPositions.length; index += 1) {
          const table = ranksByPosition[allPositions[index]];
          if (!table) {
            continue;
          }
          const entry =
            table[normalizedOpponent] ||
            table[normalizedOpponent.replace(/^@/, '')] ||
            table[`@${normalizedOpponent}`];
          if (entry) {
            return { table, position: allPositions[index], entry };
          }
        }
        return null;
      };

      const resolution = findEntry();
      if (!resolution) {
        console.debug('Sleeper+ fallback matchup unable to resolve opponent', {
          playerId: data?.playerId || item?.dataset?.[DATASET_PLAYER_ID] || null,
          opponent: normalizedOpponent,
          positions: positionHints,
          availablePositions: Object.keys(ranksByPosition || {}),
          playerTeam: data?.nflTeam || data?.team || null,
        });
        return null;
      }

      const { position, entry } = resolution;
      return {
        opponent: normalizedOpponent,
        position,
        rank: entry.rank,
        scale: entry.scale,
        sampleSize: entry.count,
        projectedAllowed: entry.total,
        playerProjection: 0,
        derived: true,
      };
    };

    const INLINE_TONE_CLASSES = ['matchup-good', 'matchup-neutral', 'matchup-bad', 'placeholder'];

    const ensureInlineMatchupShell = () => {
      const wrapper = document.createElement('div');
      wrapper.className = `${MATCHUP_INLINE_CLASS} placeholder`;

      const label = document.createElement('span');
      label.className = MATCHUP_LABEL_CLASS;
      label.textContent = 'Matchup';
      wrapper.appendChild(label);

      const value = document.createElement('span');
      value.className = MATCHUP_VALUE_CLASS;
      value.textContent = 'Rank —';
      wrapper.appendChild(value);

      return wrapper;
    };

    const ensureInlineMatchupNode = (item, host) => {
      if (!host) {
        return null;
      }
      const existing = item?.querySelector(`.${MATCHUP_INLINE_CLASS}`);
      if (existing && host.contains(existing)) {
        return existing;
      }
      if (existing && existing.parentElement) {
        existing.parentElement.removeChild(existing);
      }
      const inlineNode = existing || ensureInlineMatchupShell();
      const weatherNode = findWeatherNode(host);
      if (weatherNode) {
        weatherNode.insertAdjacentElement('afterend', inlineNode);
      } else {
        host.appendChild(inlineNode);
      }
      return inlineNode;
    };

    const ensureInlineMatchupChildren = (node) => {
      if (!node) {
        return { label: null, value: null };
      }
      let label = node.querySelector(`.${MATCHUP_LABEL_CLASS}`);
      if (!label) {
        label = document.createElement('span');
        label.className = MATCHUP_LABEL_CLASS;
        node.insertBefore(label, node.firstChild);
      }
      let value = node.querySelector(`.${MATCHUP_VALUE_CLASS}`);
      if (!value) {
        value = document.createElement('span');
        value.className = MATCHUP_VALUE_CLASS;
        node.appendChild(value);
      }
      return { label, value };
    };

    const setInlineMatchupState = (node, matchup) => {
      if (!node) {
        return;
      }
      INLINE_TONE_CLASSES.forEach((className) => node.classList.remove(className));
      const { label, value } = ensureInlineMatchupChildren(node);
      if (!label || !value) {
        return;
      }

      const rankValue = Number(matchup?.rank);
      const isByeOpponent = Boolean(matchup && isByeMatchup(matchup));
      const hasValidOpponent =
        matchup &&
        !isByeOpponent &&
        matchup.opponent &&
        matchup.position &&
        Number.isFinite(rankValue);

      if (hasValidOpponent) {
        label.textContent = '';
        label.hidden = true;
        const scale = Number(matchup.scale) || 32;
        value.textContent = `#${rankValue}/${scale}`;
        const matchupTooltip = buildMatchupTooltip(matchup);
        if (matchupTooltip) {
          node.title = matchupTooltip;
        } else {
          node.removeAttribute('title');
        }
        const toneClass = getMatchupToneClass(rankValue, scale);
        if (toneClass) {
          node.classList.add(toneClass);
        }
        return;
      }

      label.hidden = true;
      label.textContent = '';
      node.classList.add('placeholder');
      node.removeAttribute('title');
      value.textContent = isByeOpponent ? 'n/a' : '—';
    };

    const rehydrateInlineMatchup = (item) => {
      if (!item || !inlineMatchupState.has(item)) {
        return;
      }
      const cachedMatchup = inlineMatchupState.get(item) || null;
      if (!updateInlineMatchup(item, cachedMatchup)) {
        ensureInlinePlaceholder(item);
      }
    };

    const resolveInlineMutationTarget = (mutation) => {
      if (!mutation || mutation.type !== 'childList') {
        return null;
      }
      const targetElement = mutation.target instanceof Element ? mutation.target : null;
      if (targetElement?.matches?.(SCHEDULE_REHYDRATION_SELECTOR)) {
        return targetElement.closest('.team-roster-item');
      }
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!(node instanceof Element)) {
          continue;
        }
        if (node.matches(SCHEDULE_REHYDRATION_SELECTOR)) {
          return node.closest('.team-roster-item');
        }
      }
      return null;
    };

    const ensureInlinePlaceholder = (item, scheduleWrapper) => {
      const host = scheduleWrapper || findScheduleWrapper(item);
      if (!host) {
        return false;
      }
      const inlineNode = ensureInlineMatchupNode(item, host);
      if (!inlineNode) {
        return false;
      }
      setInlineMatchupState(inlineNode, null);
      return true;
    };

    const updateInlineMatchup = (item, matchup, scheduleWrapper) => {
      const host = scheduleWrapper || findScheduleWrapper(item);
      if (!host) {
        return false;
      }
      const inlineNode = ensureInlineMatchupNode(item, host);
      if (!inlineNode) {
        return false;
      }
      setInlineMatchupState(inlineNode, matchup);
      return true;
    };

    const buildSeriesSignature = (series = [], weekNumber = null) => {
      const entries = series
        .map((entry = {}) => {
          const week = entry.week ?? '';
          const actual = Number(entry.points) || 0;
          const projected =
            entry.projected === null || entry.projected === undefined ? 'null' : Number(entry.projected) || 0;
          const isFuture = entry.isFuture ? '1' : '0';
          const hasActual = entry.hasActual ? '1' : '0';
          const isDisplayed = entry.isDisplayedWeek ? '1' : '0';
          return `${week}:${actual}:${projected}:${isFuture}:${hasActual}:${isDisplayed}`;
        })
        .join('|');
      const normalizedWeek = Number.isFinite(weekNumber) ? weekNumber : 'auto';
      return `${normalizedWeek}::${entries}`;
    };

    const getPlayerSparkline = (playerId, series, { weekNumber } = {}) => {
      if (!series || series.length === 0) {
        if (playerId) {
          sparklineCache.delete(playerId);
        }
        return null;
      }
      const resolvedWeekNumber = resolveSparklineWeekNumber(series, weekNumber);
      if (!playerId) {
        return createSparkline(series, resolvedWeekNumber);
      }
      const signature = buildSeriesSignature(series, resolvedWeekNumber);
      const cached = sparklineCache.get(playerId);
      if (cached?.signature === signature && cached.svg) {
        return cached.svg.cloneNode(true);
      }
      const sparkline = createSparkline(series, resolvedWeekNumber);
      if (!sparkline) {
        return null;
      }
      sparklineCache.set(playerId, { svg: sparkline.cloneNode(true), signature });
      return sparkline;
    };

    const inferHasActual = (entry, actualValue) => {
      if (!entry) {
        return false;
      }
      if (entry.hasActual !== undefined) {
        return Boolean(entry.hasActual);
      }
      if (!entry.isFuture && Number.isFinite(actualValue)) {
        return true;
      }
      return false;
    };

    const resolveEntryValue = (entry, currentWeekNumber) => {
      if (!entry) {
        return 0;
      }
      const actual = Number(entry.points);
      const projected = Number(entry.projected);
      const hasActualData = inferHasActual(entry, actual);
      const isCurrentWeek = isCurrentWeekEntry(entry, currentWeekNumber);
      const shouldUseProjection = isCurrentWeek && !hasActualData;
      if (shouldUseProjection && Number.isFinite(projected)) {
        return projected;
      }
      if (Number.isFinite(actual)) {
        return actual;
      }
      if (Number.isFinite(projected)) {
        return projected;
      }
      return 0;
    };

    const buildSparklinePoints = (series, width, height, currentWeekNumber) => {
      if (!series || series.length === 0) {
        return { linePoints: '', areaPoints: '', coords: [] };
      }
      const resolvedValues = series.map((entry) => resolveEntryValue(entry, currentWeekNumber));
      const actualValues = resolvedValues;
      const projectionValues = series
        .map((entry) => (entry.projected !== null && entry.projected !== undefined ? Number(entry.projected) : null))
        .filter((value) => Number.isFinite(value));
      const combinedValues = projectionValues.length > 0 ? actualValues.concat(projectionValues) : actualValues;
      const max = Math.max(...combinedValues, 0);
      const min = Math.min(...combinedValues, 0);
      const range = Math.max(max - min, 1);
      const stepX = series.length > 1 ? width / (series.length - 1) : width;
      const coords = series.map((entry, index) => {
        const x = Number((index * stepX).toFixed(2));
        const normalized = (resolvedValues[index] - min) / range;
        const y = Number((height - normalized * height).toFixed(2));
        return { x, y };
      });
      const linePoints = coords.map(({ x, y }) => `${x},${y}`).join(' ');
      const areaPoints = `${coords.map(({ x, y }) => `${x},${y}`).join(' ')} ${width},${height} 0,${height}`;
      return { linePoints, areaPoints, coords, min, max, range };
    };

    const buildAreaPolygon = (coords, height) => {
      if (!coords || coords.length < 2) {
        return '';
      }
      const pathPoints = coords.map(({ x, y }) => `${x},${y}`).join(' ');
      const lastX = coords[coords.length - 1].x;
      const firstX = coords[0].x;
      return `${pathPoints} ${lastX},${height} ${firstX},${height}`;
    };

    const CURRENT_WEEK_COLOR = '#fbbf24';
    const LINE_COLORS = {
      over: '#22c55e',
      under: '#e35a5a',
      neutral: '#3b82f6',
      future: '#94a3b8',
      current: CURRENT_WEEK_COLOR,
    };

    function parseSeriesWeekNumber(entry) {
      if (!entry || entry.week === null || entry.week === undefined) {
        return null;
      }
      if (Number.isFinite(entry.week)) {
        return Number(entry.week);
      }
      const numeric = Number(entry.week);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
      if (typeof entry.week === 'string') {
        const match = entry.week.match(/\d+/);
        if (match) {
          const parsed = Number(match[0]);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
      return null;
    }

    function resolveSparklineWeekNumber(series, preferredWeekNumber = null) {
      const normalizedPreferred = Number.isFinite(preferredWeekNumber) ? Number(preferredWeekNumber) : null;
      if (!Array.isArray(series) || series.length === 0) {
        return normalizedPreferred;
      }
      if (
        Number.isFinite(normalizedPreferred) &&
        series.some((entry) => parseSeriesWeekNumber(entry) === normalizedPreferred)
      ) {
        return normalizedPreferred;
      }
      const displayedEntry = series.find((entry) => entry && entry.isDisplayedWeek);
      const displayedWeek = parseSeriesWeekNumber(displayedEntry);
      if (Number.isFinite(displayedWeek)) {
        return displayedWeek;
      }
      for (let index = series.length - 1; index >= 0; index -= 1) {
        const entry = series[index];
        if (!entry || entry.isFuture) {
          continue;
        }
        const week = parseSeriesWeekNumber(entry);
        if (Number.isFinite(week)) {
          return week;
        }
      }
      return normalizedPreferred;
    }

    const isCurrentWeekEntry = (entry, currentWeekNumber) => {
      if (!Number.isFinite(currentWeekNumber)) {
        return false;
      }
      const entryWeek = parseSeriesWeekNumber(entry);
      return Number.isFinite(entryWeek) && entryWeek === currentWeekNumber;
    };

    const classifyWeek = (entry, currentWeekNumber) => {
      if (!entry) {
        return 'neutral';
      }
      const actual = Number(entry.points);
      const projectedValue =
        entry.projected === null || entry.projected === undefined ? null : Number(entry.projected);
      const normalizedProjected = Number.isFinite(projectedValue) ? projectedValue : null;
      const isCurrentWeek = isCurrentWeekEntry(entry, currentWeekNumber);
      const hasActualData = inferHasActual(entry, actual);
      if (isCurrentWeek && !hasActualData) {
        return 'current';
      }
      if (!hasActualData || normalizedProjected === null) {
        return 'neutral';
      }
      const resolvedActual = Number.isFinite(actual) ? actual : 0;
      return resolvedActual >= normalizedProjected ? 'over' : 'under';
    };

    const segmentLinePoints = (coords, series, currentWeekNumber) => {
      if (!coords || coords.length === 0 || !series || series.length === 0) {
        return [];
      }
      const segments = [];
      let currentClass = classifyWeek(series[0], currentWeekNumber);
      let currentPoints = [coords[0]];

      for (let index = 1; index < coords.length; index += 1) {
        const nextClass = classifyWeek(series[index], currentWeekNumber);
        const point = coords[index];
        if (nextClass !== currentClass) {
          if (currentPoints.length >= 2) {
            segments.push({ classification: currentClass, points: currentPoints.slice() });
          }
          currentPoints = [coords[index - 1], point];
          currentClass = nextClass;
        } else {
          currentPoints.push(point);
        }
      }

      if (currentPoints.length >= 2) {
        segments.push({ classification: currentClass, points: currentPoints.slice() });
      }

      return segments;
    };

    // TODO(sparkline-season): Extend series generation so we pad weeklySeries with
    // the full current-season schedule, sourcing projections for future weeks,
    // rendering those projected-only points/segments in teal, and highlighting
    // the active week marker/segment in gold for quick visual orientation.
    const createSparkline = (series, overrideWeekNumber = null) => {
      if (!series || series.length === 0) {
        return null;
      }
      const width = 220;
      const height = 48;
      const preferredWeekNumber = Number.isFinite(overrideWeekNumber)
        ? Number(overrideWeekNumber)
        : getCurrentWeekNumber();
      const resolvedWeekNumber = resolveSparklineWeekNumber(series, preferredWeekNumber);
      const { areaPoints, coords, min, range } = buildSparklinePoints(series, width, height, resolvedWeekNumber);
      if (!coords || coords.length === 0) {
        return null;
      }
      const futureStartIndex = series.findIndex((entry) => entry && entry.isFuture);
      const hasFuture = futureStartIndex >= 0;
      const actualLength = hasFuture ? futureStartIndex : coords.length;
      const actualCoords = actualLength > 0 ? coords.slice(0, actualLength) : [];
      const actualSeries = actualLength > 0 ? series.slice(0, actualLength) : [];

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('preserveAspectRatio', 'none');

      const resolvedAreaPoints = hasFuture ? buildAreaPolygon(actualCoords, height) : areaPoints;
      if (resolvedAreaPoints) {
        const area = document.createElementNS(SVG_NS, 'polygon');
        area.setAttribute('points', resolvedAreaPoints);
        svg.appendChild(area);
      }

      const segments = segmentLinePoints(actualCoords, actualSeries, resolvedWeekNumber);
      if (segments.length === 0 && actualCoords.length > 0) {
        const fallbackClass = classifyWeek(actualSeries[0], resolvedWeekNumber);
        const fallbackPoints =
          actualCoords.length === 1 ? [actualCoords[0], actualCoords[0]] : actualCoords;
        segments.push({ classification: fallbackClass, points: fallbackPoints });
      }
      segments.forEach((segment) => {
        const polyline = document.createElementNS(SVG_NS, 'polyline');
        const linePoints = segment.points.map(({ x, y }) => `${x},${y}`).join(' ');
        polyline.setAttribute('points', linePoints);
        polyline.classList.add('sleeper-plus-line', `line-${segment.classification}`);
        polyline.style.stroke = LINE_COLORS[segment.classification] || LINE_COLORS.neutral;
        svg.appendChild(polyline);
      });

      const projectionCoords = [];
      coords.forEach(({ x }, index) => {
        const projected = series[index]?.projected;
        if (projected === null || projected === undefined) {
          projectionCoords.push(null);
          return;
        }
        const normalized = (Number(projected) - (min ?? 0)) / (range || 1);
        const y = Number((height - normalized * height).toFixed(2));
        projectionCoords[index] = { x, y };
      });

      if (hasFuture) {
        const futurePoints = [];
        const anchorIndex = actualLength > 0 ? actualLength - 1 : null;
        if (anchorIndex !== null && coords[anchorIndex]) {
          futurePoints.push(coords[anchorIndex]);
        }
        for (let index = futureStartIndex; index < projectionCoords.length; index += 1) {
          const projectedPoint = projectionCoords[index];
          if (projectedPoint) {
            futurePoints.push(projectedPoint);
          }
        }
        if (futurePoints.length >= 2) {
          const futureLine = document.createElementNS(SVG_NS, 'polyline');
          const futureLinePoints = futurePoints.map(({ x, y }) => `${x},${y}`).join(' ');
          futureLine.setAttribute('points', futureLinePoints);
          futureLine.classList.add('sleeper-plus-line', 'line-future');
          futureLine.style.stroke = LINE_COLORS.future;
          svg.appendChild(futureLine);
        }
      }

      const projectionLinePoints = projectionCoords
        .map((entry) => (entry ? `${entry.x},${entry.y}` : ''))
        .filter(Boolean)
        .join(' ');
      if (projectionLinePoints) {
        const projectionLine = document.createElementNS(SVG_NS, 'polyline');
        projectionLine.setAttribute('points', projectionLinePoints);
        projectionLine.classList.add('sleeper-plus-projection-line');
        svg.appendChild(projectionLine);
      }

      const dotsGroup = document.createElementNS(SVG_NS, 'g');
      coords.forEach(({ x, y }, index) => {
        const dataPoint = series[index];
        if (!dataPoint) {
          return;
        }
        const isFuture = Boolean(dataPoint.isFuture);
        const projected = dataPoint.projected;
        const actual = Number(dataPoint.points) || 0;
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('r', 2.8);
        const formattedWeek = dataPoint.week ?? '?';
        const formattedProjected =
          projected !== null && projected !== undefined ? formatNumber(projected) : '—';
        const formattedActual = isFuture ? '—' : formatNumber(actual) || '—';
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `Week: ${formattedWeek} - Proj: ${formattedProjected} - Pts: ${formattedActual}`;
        circle.appendChild(title);

        if (isFuture) {
          const projectedPoint = projectionCoords[index];
          if (!projectedPoint) {
            return;
          }
          circle.setAttribute('cx', projectedPoint.x);
          circle.setAttribute('cy', projectedPoint.y);
          circle.classList.add('sleeper-plus-dot', 'future');
          circle.style.fill = LINE_COLORS.future;
          circle.style.stroke = '#1f2937';
        } else {
          circle.setAttribute('cx', x);
          circle.setAttribute('cy', y);
          const classification = classifyWeek(dataPoint, resolvedWeekNumber);
          circle.classList.add('sleeper-plus-dot', classification);
          circle.style.fill = LINE_COLORS[classification] || LINE_COLORS.neutral;
        }

        dotsGroup.appendChild(circle);
      });
      svg.appendChild(dotsGroup);

      return svg;
    };

    const formatNumber = (value) => {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return '';
      }
      const numeric = Number(value);
      if (Number.isInteger(numeric)) {
        return numeric.toString();
      }
      return numeric.toFixed(1);
    };

    const renderMessage = (item, message, { weekKey, overlayRoster } = {}) => {
      removeTrend(item);
      const scheduleWrapper = findScheduleWrapper(item);
      const host = resolveTrendHost(scheduleWrapper, item);
      const trendRowHost =
        (host instanceof Element ? host.closest('.row') : null) ||
        (scheduleWrapper?.closest?.('.row') || null) ||
        host;
      if (trendRowHost) {
        trendRowHost.classList.add('sleeper-plus-trend-row');
      }
      if (!host) {
        return;
      }
      const container = document.createElement('div');
      container.className = `${CONTAINER_CLASS} ${ERROR_CLASS}`;
      container.textContent = message;
      host.appendChild(container);
      item.dataset[DATASET_STATE] = 'error';
      setItemWeekKey(item, weekKey || getCurrentWeekKey());
      if (showOpponentRanks && !overlayRoster) {
        ensureInlinePlaceholder(item, scheduleWrapper);
        inlineMatchupState.set(item, null);
      }
    };

    const renderTrend = (item, data, { weekKey, overlayRoster } = {}) => {
      removeTrend(item);
      const scheduleWrapper = findScheduleWrapper(item);
      const host = resolveTrendHost(scheduleWrapper, item);
      const trendRowHost =
        (host instanceof Element ? host.closest('.row') : null) ||
        (scheduleWrapper?.closest?.('.row') || null) ||
        host;
      if (trendRowHost) {
        trendRowHost.classList.add('sleeper-plus-trend-row');
      }

      const container = document.createElement('div');
      container.className = CONTAINER_CLASS;

      const stack = document.createElement('div');
      stack.className = STACK_CLASS;
      container.appendChild(stack);

      const meta = document.createElement('div');
      meta.className = META_CLASS;
      const metaItems = [];

      if (data.positionRank?.rank) {
        const positionLabel =
          data.positionRank.position && data.positionRank.position !== 'UNK'
            ? data.positionRank.position
            : 'Rank';
        const rankValue = `#${data.positionRank.rank}`;
        metaItems.push(
          createMetaItem(positionLabel, rankValue, {
            title: `${positionLabel} rank ${data.positionRank.rank}`,
          })
        );
      }

      if (data.totalPoints !== undefined) {
        metaItems.push(createMetaItem('Pts', formatNumber(data.totalPoints)));
      }

      if (data.age) {
        metaItems.push(createMetaItem('Age', formatNumber(data.age)));
      }

      if (data.yearsExp !== undefined) {
        metaItems.push(createMetaItem('Exp', formatNumber(data.yearsExp)));
      }

      metaItems.filter(Boolean).forEach((node) => meta.appendChild(node));
      if (meta.children.length > 0) {
        stack.appendChild(meta);
      }

      const allowOpponentDetails = showOpponentRanks && !overlayRoster;
      if (allowOpponentDetails) {
        const matchupData = data.matchup || buildFallbackMatchup(data, item, scheduleWrapper);
        inlineMatchupState.set(item, matchupData || null);
        if (matchupData) {
          console.debug('Sleeper+ inline matchup payload', {
            playerId: data?.playerId || item?.dataset?.[DATASET_PLAYER_ID] || null,
            source: data.matchup ? 'direct' : 'fallback',
            opponent: matchupData.opponent,
            rank: matchupData.rank,
            scale: matchupData.scale,
          });
        } else {
          console.info('Sleeper+ inline matchup missing', {
            playerId: data?.playerId || item?.dataset?.[DATASET_PLAYER_ID] || null,
            hasOpponentRanks: Boolean(data.opponentRanks),
            primaryPosition: data.primaryPosition,
            playerTeam: data?.nflTeam || data?.team || null,
          });
        }
        const attachedInline = updateInlineMatchup(item, matchupData || null, scheduleWrapper);
        if (matchupData && !attachedInline) {
          const matchupNode = createMatchupNode(matchupData);
          if (matchupNode) {
            container.appendChild(matchupNode);
          }
        }
      }

      const chartWrapper = document.createElement('div');
      chartWrapper.className = CHART_CLASS;
      const playerChartId = item?.dataset?.[DATASET_PLAYER_ID] || '';
      const allowSparkline = (!overlayRoster && enableTrendOverlays) || (overlayRoster && showSparklineAlways);
      let chart = null;
      const activeWeekNumber = getCurrentWeekNumber();
      const resolvedSparklineWeek = Number.isFinite(activeWeekNumber)
        ? activeWeekNumber
        : Number.isFinite(data.sparklineWeek)
          ? Number(data.sparklineWeek)
          : undefined;
      if (allowSparkline) {
        chart = getPlayerSparkline(playerChartId, data.weeklySeries, {
          weekNumber: resolvedSparklineWeek,
        });
      }
      if (allowSparkline && chart) {
        chartWrapper.appendChild(chart);
        stack.appendChild(chartWrapper);
      }

      host.appendChild(container);
      item.dataset[DATASET_STATE] = 'ready';
      setItemWeekKey(item, weekKey || getCurrentWeekKey());
    };

    const processRosterItem = (item) => {
      if (!item || !item.isConnected || !leagueId) {
        return;
      }
      const identity = extractIdentity(item);
      if (!identity.playerId && !identity.fullName) {
        removeTrend(item);
        return;
      }

      const overlayRoster = isOverlayRoster(item);
      const allowOpponentDetails = showOpponentRanks && !overlayRoster;

      if (allowOpponentDetails) {
        ensureInlinePlaceholder(item);
      }

      if (processingMap.has(item)) {
        return;
      }

      const task = (async () => {
        let weekContext = null;
        try {
          const resolvedId = await resolvePlayerId(identity);
          if (!resolvedId) {
            renderMessage(item, 'Sleeper+ trend unavailable', {
              weekKey: getCurrentWeekKey(),
              overlayRoster,
            });
            return;
          }
          const currentWeekKey = getCurrentWeekKey();
          const priorId = item.dataset[DATASET_PLAYER_ID];
          if (
            priorId === resolvedId &&
            item.dataset[DATASET_STATE] === 'ready' &&
            item.dataset[DATASET_WEEK] === currentWeekKey
          ) {
            return;
          }
          item.dataset[DATASET_PLAYER_ID] = resolvedId;
          weekContext = { weekNumber: getCurrentWeekNumber(), cacheKey: currentWeekKey };
          const trend = await fetchTrendData(resolvedId, weekContext);
          if (weekContext.cacheKey !== getCurrentWeekKey()) {
            scheduleScan();
            return;
          }
          renderTrend(item, trend, { weekKey: weekContext.cacheKey, overlayRoster });
        } catch (error) {
          renderMessage(item, 'Sleeper+ trend unavailable', {
            weekKey: weekContext?.cacheKey || getCurrentWeekKey(),
            overlayRoster,
          });
          console.warn('Sleeper+ trend render failed', error);
        }
      })();

      processingMap.set(item, task.finally(() => processingMap.delete(item)));
    };

    const performScan = () => {
      if (!running || !leagueId) {
        return;
      }
      const roster = document.querySelector('.team-roster');
      if (!roster) {
        cleanupAll();
        return;
      }
      const items = roster.querySelectorAll('.team-roster-item');
      if (items.length === 0) {
        cleanupAll();
        return;
      }
      items.forEach((item) => processRosterItem(item));
    };

    const scheduleScan = () => {
      if (!running || scanScheduled) {
        return;
      }
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        performScan();
      });
    };

    const withinWeekBounds = (value) => Number.isFinite(value) && value >= 1 && value <= 30;

    const applyActiveWeek = (nextWeek) => {
      if (!withinWeekBounds(nextWeek) || nextWeek === activeWeek) {
        return false;
      }
      activeWeek = nextWeek;
      if (running) {
        cleanupAll();
        scheduleScan();
      }
      return true;
    };

    const syncWeekFromService = () => {
      const targetLeagueId = leagueId || getCurrentLeagueId();
      if (!targetLeagueId) {
        return;
      }
      activeWeekService
        .fetchWeek(targetLeagueId)
        .then((week) => applyActiveWeek(week))
        .catch((error) => {
          console.debug('Sleeper+ week sync failed', error);
        });
    };

    const startWeekWatch = () => {
      if (weekPollIntervalId) {
        return;
      }
      syncWeekFromService();
      weekPollIntervalId = window.setInterval(() => syncWeekFromService(), WEEK_POLL_INTERVAL_MS);
    };

    const stopWeekWatch = () => {
      if (weekPollIntervalId) {
        window.clearInterval(weekPollIntervalId);
        weekPollIntervalId = null;
      }
      activeWeek = null;
    };

    const shouldReactToMutation = (mutation) => {
      if (mutation.type !== 'childList') {
        return false;
      }
      const hasRosterItem = (nodes) => {
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index];
          if (!(node instanceof Element)) {
            continue;
          }
          if (node.classList.contains('team-roster-item')) {
            return true;
          }
        }
        return false;
      };
      return hasRosterItem(mutation.addedNodes) || hasRosterItem(mutation.removedNodes);
    };

    const disconnectRosterObserver = () => {
      if (rosterObserver) {
        rosterObserver.disconnect();
        rosterObserver = null;
      }
      observedRoster = null;
    };

    const connectRosterObserver = (target) => {
      if (!target || observedRoster === target) {
        return false;
      }
      disconnectRosterObserver();
      rosterObserver = new MutationObserver((mutations) => {
        if (!running) {
          return;
        }
        let shouldScan = false;
        const hydrationTargets = new Set();
        mutations.forEach((mutation) => {
          if (shouldReactToMutation(mutation)) {
            shouldScan = true;
            return;
          }
          const targetItem = resolveInlineMutationTarget(mutation);
          if (targetItem) {
            hydrationTargets.add(targetItem);
          }
        });
        hydrationTargets.forEach((item) => rehydrateInlineMatchup(item));
        if (shouldScan) {
          scheduleScan();
        }
      });
      rosterObserver.observe(target, { childList: true, subtree: true });
      observedRoster = target;
      return true;
    };

    const watchRosterTarget = () => {
      if (!running) {
        return;
      }
      const roster = document.querySelector('.team-roster');
      if (!roster) {
        if (observedRoster) {
          disconnectRosterObserver();
          cleanupAll();
        }
        return;
      }
      const attached = connectRosterObserver(roster);
      if (attached) {
        scheduleScan();
      }
    };

    const startRosterWatch = () => {
      if (rosterWatchInterval) {
        return;
      }
      watchRosterTarget();
      rosterWatchInterval = window.setInterval(() => watchRosterTarget(), 1500);
    };

    const stopRosterWatch = () => {
      if (rosterWatchInterval) {
        window.clearInterval(rosterWatchInterval);
        rosterWatchInterval = null;
      }
      disconnectRosterObserver();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopRosterWatch();
      } else if (running) {
        startRosterWatch();
        scheduleScan();
      }
    };

    const attachVisibilityListener = () => {
      if (visibilityListenerAttached) {
        return;
      }
      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = true;
    };

    const detachVisibilityListener = () => {
      if (!visibilityListenerAttached) {
        return;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = false;
    };

    const start = () => {
      if (running || !leagueId) {
        return;
      }
      running = true;
      attachVisibilityListener();
      startRosterWatch();
      startWeekWatch();
      scheduleScan();
    };

    const stop = () => {
      if (!running) {
        cleanupAll();
        stopRosterWatch();
        stopWeekWatch();
        detachVisibilityListener();
        pendingTrendRequests = 0;
        updateRefreshIndicator();
        return;
      }
      running = false;
      stopRosterWatch();
      stopWeekWatch();
      detachVisibilityListener();
      cleanupAll();
      pendingTrendRequests = 0;
      updateRefreshIndicator();
    };

    const setLeagueContext = (nextLeagueId) => {
      if (leagueId === nextLeagueId) {
        return;
      }
      leagueId = nextLeagueId || '';
      activeWeek = null;
      cleanupAll();
      trendCache.clear();
      sparklineCache.clear();
      sparklineSourceCache.clear();
      inflightTrends.clear();
      pendingTrendRequests = 0;
      updateRefreshIndicator();
      if (!leagueId) {
        stop();
      } else {
        syncWeekFromService();
        if (running) {
          scheduleScan();
        }
      }
    };

    const update = ({ enabled, leagueId: nextLeagueId }) => {
      setLeagueContext(nextLeagueId);
      if (enabled && leagueId) {
        start();
      } else {
        stop();
      }
    };

    const refresh = () => {
      if (running) {
        scheduleScan();
      }
    };

    return { update, refresh, stop };
  })();

  const teamTotalsController = (() => {
    const PANEL_ID = 'sleeper-plus-team-totals';
    const PANEL_CLASS = 'sleeper-plus-team-totals';
    const PANEL_HIDDEN_CLASS = 'is-hidden';
    const PANEL_LOADING_CLASS = 'is-loading';
    const USER_TAB_HOST_CLASS = 'sleeper-plus-user-tab-host';
    const USER_TAB_ROW_CLASS = 'sleeper-plus-user-tab-row';
    const IDENTITY_PLACEHOLDER_CLASS = 'sleeper-plus-identity-placeholder';
    const IDENTITY_SLOT_CLASS = `${PANEL_CLASS}__identity-slot`;
    const WEEK_DETECT_SELECTORS = [
      '.week-nav button[aria-pressed="true"],.week-nav button.is-active',
      '.week-nav__value',
      '[data-testid*="week-nav" i]',
      '[aria-label*="week" i][aria-pressed="true"]',
      '[data-testid*="week" i][aria-pressed="true"]',
      '.week-selector button.is-selected',
      '.week-selector .week.is-selected',
      '.week-selector .week.selected',
      '.week-container .week.selected',
      '.week-container .week.is-selected',
      '.week-container .week[aria-selected="true"]',
      '.week-selector-dropdown .week.selected',
      '.week-selector-dropdown .week[aria-selected="true"]',
      '.week-items .week.selected',
      '.week-items .week.is-selected',
      '.week-items .week[aria-selected="true"]',
      '.week-select__option[aria-selected="true"]',
      '.week-select__option.is-selected',
      '.week-select__value',
      '[class*="week-value" i]',
    ];
    const WEEK_FALLBACK_SELECTOR =
      '.week-nav button,.week-nav__value,[data-week],[data-leg],[data-testid*="week" i],[class*="week" i],[aria-label*="week" i],[title*="week" i]';
    const WEEK_CLICK_TARGET_SELECTOR =
      '[data-testid*="week" i],.week-selector button,.week-select__option,[class*="week-selector" i] button,.week-nav button,.week-container .week,.week-items .week,.week-selector-dropdown .week';
    const LINEUP_INTERACTION_EVENTS = ['mouseup', 'touchend', 'keyup'];
    const WEEK_POLL_INTERVAL_MS = 1500;

    let running = false;
    let leagueId = '';
    let rosterId = '';
    let refreshScheduled = false;
    let pendingForceRefresh = false;
    let lastContextSignature = '';
    let inflightRequestId = 0;
    let selectedWeek = null;
    let apiWeek = null;

    let panelRefs = null;
    let lastRenderedTotals = null;
    let rosterObserver = null;
    let observedRoster = null;
    let rosterWatchInterval = null;
    let weekPollIntervalId = null;
    let weekClickListenerAttached = false;
    let visibilityListenerAttached = false;
    let interactionListenerAttached = false;

    const isElementVisible = (element) => {
      if (!element || !element.isConnected) {
        return false;
      }
      if (element.offsetParent) {
        return true;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (!style) {
        return true;
      }
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      return Number(style.opacity || 1) !== 0;
    };

    const findNearbyUserTabMenu = () => {
      const roster = document.querySelector('.team-roster');
      if (!roster) {
        return null;
      }
      let ancestor = roster.parentElement;
      while (ancestor && ancestor !== document.body) {
        const menu = ancestor.querySelector('.user-tab-menu');
        if (menu) {
          return menu;
        }
        ancestor = ancestor.parentElement;
      }
      return null;
    };

    const resolvePanelHost = () => {
      const nearby = findNearbyUserTabMenu();
      if (isElementVisible(nearby)) {
        return nearby;
      }
      const menus = Array.from(document.querySelectorAll('.user-tab-menu'));
      return menus.find((menu) => isElementVisible(menu)) || nearby || null;
    };

    const withinWeekBounds = (value) => Number.isFinite(value) && value >= 1 && value <= 30;

    const parseWeekFromValue = (value) => {
      if (value === null || value === undefined) {
        return null;
      }
      const normalized = value.toString().trim();
      if (!normalized) {
        return null;
      }
      const direct = Number(normalized);
      if (withinWeekBounds(direct)) {
        return direct;
      }
      const keywordMatch = normalized.match(/(?:week|wk|leg)[^0-9]{0,6}(\d{1,2})/i);
      if (keywordMatch) {
        const candidate = Number(keywordMatch[1]);
        if (withinWeekBounds(candidate)) {
          return candidate;
        }
      }
      const digits = normalized.replace(/[^0-9]/g, '');
      if (digits) {
        const numeric = Number(digits);
        if (withinWeekBounds(numeric)) {
          return numeric;
        }
      }
      return null;
    };

    const extractWeekFromElement = (element) => {
      if (!(element instanceof Element)) {
        return null;
      }
      const dataAttributes = element.dataset ? Object.values(element.dataset) : [];
      const attributeCandidates = [
        element.getAttribute('data-week'),
        element.getAttribute('data-leg'),
        element.getAttribute('data-value'),
        element.getAttribute('data-option'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
        ...dataAttributes,
      ];
      for (let index = 0; index < attributeCandidates.length; index += 1) {
        const parsed = parseWeekFromValue(attributeCandidates[index]);
        if (withinWeekBounds(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const detectDisplayedWeekNumber = () => {
      for (let index = 0; index < WEEK_DETECT_SELECTORS.length; index += 1) {
        const selector = WEEK_DETECT_SELECTORS[index];
        if (!selector) {
          continue;
        }
        const nodes = document.querySelectorAll(selector);
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          const parsed = extractWeekFromElement(nodes[nodeIndex]);
          if (withinWeekBounds(parsed)) {
            nodes[nodeIndex].dataset.sleeperPlusWeek = String(parsed);
            return parsed;
          }
        }
      }
      const fallbackNodes = Array.from(document.querySelectorAll(WEEK_FALLBACK_SELECTOR)).slice(0, 50);
      for (let index = 0; index < fallbackNodes.length; index += 1) {
        const parsed = extractWeekFromElement(fallbackNodes[index]);
        if (withinWeekBounds(parsed)) {
          return parsed;
        }
      }
      try {
        const params = new URLSearchParams(window.location.search || '');
        const fromQuery = parseWeekFromValue(params.get('week'));
        if (withinWeekBounds(fromQuery)) {
          return fromQuery;
        }
      } catch (_error) {
        // ignore
      }
      return null;
    };

    const normalizeWeekValue = (value) => {
      const numeric = Number(value);
      return withinWeekBounds(numeric) ? numeric : null;
    };

    const getSelectedWeekNumber = () => (Number.isFinite(selectedWeek) ? selectedWeek : null);
    const getApiWeekNumber = () => (Number.isFinite(apiWeek) ? apiWeek : null);

    const setWeekLabel = (weekNumber, refs = null) => {
      const targets = refs || panelRefs || (running ? getPanelRefs() : null);
      if (!targets?.week) {
        return;
      }
      targets.week.textContent = Number.isFinite(weekNumber) ? `Week ${weekNumber}` : 'This Week';
    };

    const setSelectedWeek = (value, { notify = true } = {}) => {
      const normalized = normalizeWeekValue(value);
      if (normalized === selectedWeek) {
        return selectedWeek;
      }
      selectedWeek = normalized;
      setWeekLabel(selectedWeek);
      if (notify) {
        scheduleRefresh({ force: true });
      }
      return selectedWeek;
    };

    const setApiWeek = (value) => {
      const normalized = normalizeWeekValue(value);
      if (apiWeek === normalized) {
        return;
      }
      apiWeek = normalized;
      if (!Number.isFinite(selectedWeek) && Number.isFinite(apiWeek)) {
        setSelectedWeek(apiWeek);
      } else if (Number.isFinite(apiWeek)) {
        scheduleRefresh();
      }
    };

    const resetWeekState = () => {
      selectedWeek = null;
      apiWeek = null;
      setWeekLabel(null);
    };

    const getDisplayWeekNumber = () => {
      if (Number.isFinite(selectedWeek)) {
        return selectedWeek;
      }
      const detected = detectDisplayedWeekNumber();
      if (withinWeekBounds(detected)) {
        return detected;
      }
      return getApiWeekNumber();
    };

    const syncWeekFromService = () => {
      const targetLeagueId = leagueId || getCurrentLeagueId();
      if (!targetLeagueId) {
        return;
      }
      activeWeekService
        .fetchWeek(targetLeagueId)
        .then((week) => {
          setApiWeek(week);
        })
        .catch((error) => {
          console.debug('Sleeper+ totals week sync failed', error);
        });
    };

    const handleWeekInteraction = (event) => {
      const target = event?.target instanceof Element ? event.target.closest(WEEK_CLICK_TARGET_SELECTOR) : null;
      if (!target) {
        return;
      }
      window.requestAnimationFrame(() => setSelectedWeek(detectDisplayedWeekNumber()));
      window.setTimeout(() => setSelectedWeek(detectDisplayedWeekNumber()), 250);
    };

    const startWeekWatcher = () => {
      if (weekPollIntervalId) {
        return;
      }
      syncWeekFromService();
      setSelectedWeek(detectDisplayedWeekNumber());
      weekPollIntervalId = window.setInterval(
        () => setSelectedWeek(detectDisplayedWeekNumber()),
        WEEK_POLL_INTERVAL_MS
      );
      if (!weekClickListenerAttached) {
        document.addEventListener('click', handleWeekInteraction, true);
        weekClickListenerAttached = true;
      }
    };

    const stopWeekWatcher = () => {
      if (weekPollIntervalId) {
        window.clearInterval(weekPollIntervalId);
        weekPollIntervalId = null;
      }
      if (weekClickListenerAttached) {
        document.removeEventListener('click', handleWeekInteraction, true);
        weekClickListenerAttached = false;
      }
      resetWeekState();
    };

    const PLAYER_ID_DATASET_KEYS = ['playerId', 'player_id', 'playerid', 'player'];
    const PLAYER_ID_ATTRIBUTE_KEYS = ['data-player-id', 'data-playerid', 'data-player'];
    const PLAYER_ID_QUERY_SELECTORS = ['[data-player-id]', '[data-playerId]', '[data-playerid]'];
    const SLOT_LABEL_SELECTORS = [
      '.slot-label',
      '.slot',
      '.team-roster-slot',
      '.team-roster-position',
      '.player-position',
      '.team-roster__slot',
      '.team-roster__position',
      '[data-slot]',
      '[data-position]',
      '[data-role]',
    ];
    const BENCH_SLOT_TOKENS = ['bn', 'bench', 'be', 'tx', 'taxi', 'res', 'reserve', 'ir', 'ir+', 'inj', 'injured', 'pup', 'cov', 'covid', 'sus', 'susp', 'out', 'na'];

    const sanitizePlayerIdValue = (value) => {
      if (value === null || value === undefined) {
        return '';
      }
      const normalized = String(value).trim();
      return normalized || '';
    };

    const extractPlayerIdFromNode = (node) => {
      if (!node) {
        return '';
      }
      const dataset = node.dataset || {};
      for (let index = 0; index < PLAYER_ID_DATASET_KEYS.length; index += 1) {
        const value = dataset[PLAYER_ID_DATASET_KEYS[index]];
        const sanitized = sanitizePlayerIdValue(value);
        if (sanitized) {
          return sanitized;
        }
      }
      for (let index = 0; index < PLAYER_ID_ATTRIBUTE_KEYS.length; index += 1) {
        const value = node.getAttribute?.(PLAYER_ID_ATTRIBUTE_KEYS[index]);
        const sanitized = sanitizePlayerIdValue(value);
        if (sanitized) {
          return sanitized;
        }
      }
      return '';
    };

    const extractPlayerIdFromLabel = (label) => {
      const normalized = sanitizePlayerIdValue(label);
      if (!normalized) {
        return '';
      }
      const direct = normalized.match(/player[^a-z0-9]*([a-z0-9_:-]+)/i);
      if (direct && direct[1]) {
        return sanitizePlayerIdValue(direct[1]);
      }
      if (/^[0-9]+$/.test(normalized)) {
        return normalized;
      }
      return '';
    };

    const isBenchLabelValue = (value) => {
      if (value === null || value === undefined) {
        return false;
      }
      const normalized = String(value).trim().toLowerCase();
      if (!normalized) {
        return false;
      }
      return BENCH_SLOT_TOKENS.some((token) => normalized === token || normalized.startsWith(`${token} `));
    };

    const gatherSlotLabels = (item) => {
      if (!item) {
        return [];
      }
      const collected = [];
      const dataset = item.dataset || {};
      ['slot', 'position', 'role'].forEach((key) => {
        if (dataset[key]) {
          collected.push(dataset[key]);
        }
      });
      for (let index = 0; index < SLOT_LABEL_SELECTORS.length; index += 1) {
        const selector = SLOT_LABEL_SELECTORS[index];
        const node = item.querySelector(selector);
        if (!node) {
          continue;
        }
        const nodeDataset = node.dataset || {};
        ['slot', 'position', 'role'].forEach((key) => {
          if (nodeDataset[key]) {
            collected.push(nodeDataset[key]);
          }
        });
        if (node.textContent) {
          collected.push(node.textContent);
        }
      }
      return collected;
    };

    const extractLeadingSlotText = (item) => {
      if (!item) {
        return '';
      }
      const text = item.textContent || '';
      const trimmed = text.trim();
      if (!trimmed) {
        return '';
      }
      const firstWord = trimmed.split(/\s+/)[0];
      return firstWord ? firstWord.replace(/[^a-z0-9+]/gi, '') : '';
    };

    const isBenchItem = (item) => {
      if (!item) {
        return false;
      }
      if (
        Array.from(item.classList || []).some((token) =>
          BENCH_SLOT_TOKENS.some((benchToken) => token.toLowerCase().includes(benchToken))
        )
      ) {
        return true;
      }
      const slotLabels = gatherSlotLabels(item);
      if (slotLabels.some((label) => isBenchLabelValue(label))) {
        return true;
      }
      const leadingSlot = extractLeadingSlotText(item).toLowerCase();
      if (!leadingSlot) {
        return false;
      }
      return BENCH_SLOT_TOKENS.some(
        (token) => leadingSlot === token || leadingSlot.startsWith(token)
      );
    };

    const extractPlayerIdFromRosterItem = (item) => {
      const direct = extractPlayerIdFromNode(item);
      if (direct) {
        return direct;
      }
      for (let index = 0; index < PLAYER_ID_QUERY_SELECTORS.length; index += 1) {
        const nested = item.querySelector(PLAYER_ID_QUERY_SELECTORS[index]);
        const nestedValue = extractPlayerIdFromNode(nested);
        if (nestedValue) {
          return nestedValue;
        }
      }
      const avatar = item.querySelector('.avatar-player[aria-label]');
      const avatarLabel = avatar?.getAttribute('aria-label') || '';
      const fromLabel = extractPlayerIdFromLabel(avatarLabel);
      if (fromLabel) {
        return fromLabel;
      }
      const avatarDataset = extractPlayerIdFromNode(avatar);
      if (avatarDataset) {
        return avatarDataset;
      }
      const link = item.querySelector('a[href*="/player/"]');
      const href = link?.getAttribute('href') || '';
      const match = href.match(/player(?:s)?\/([^/?#]+)/i);
      if (match && match[1]) {
        return sanitizePlayerIdValue(match[1]);
      }
      return '';
    };

    const dedupeList = (list) => {
      const seen = new Set();
      const result = [];
      (list || []).forEach((value) => {
        const normalized = sanitizePlayerIdValue(value);
        if (!normalized || seen.has(normalized)) {
          return;
        }
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    };

    const collectRosterPlayerIds = () => {
      const roster = document.querySelector('.team-roster');
      if (!roster) {
        return [];
      }
      const items = roster.querySelectorAll('.team-roster-item');
      if (!items || items.length === 0) {
        return [];
      }
      const starters = [];
      const fallback = [];
      items.forEach((item) => {
        const playerId = extractPlayerIdFromRosterItem(item);
        if (!playerId) {
          return;
        }
        fallback.push(playerId);
        if (!isBenchItem(item)) {
          starters.push(playerId);
        }
      });
      const starterIds = dedupeList(starters);
      if (starterIds.length > 0) {
        return starterIds;
      }
      return dedupeList(fallback);
    };

    const identityPlaceholderMap = new WeakMap();

    const ensureIdentityPlaceholder = (node) => {
      if (!node || identityPlaceholderMap.has(node)) {
        return identityPlaceholderMap.get(node) || null;
      }
      const placeholder = document.createElement('div');
      placeholder.className = IDENTITY_PLACEHOLDER_CLASS;
      placeholder.style.display = 'none';
      if (node.parentElement) {
        node.parentElement.insertBefore(placeholder, node);
      }
      identityPlaceholderMap.set(node, placeholder);
      return placeholder;
    };

    const restoreIdentityRow = (node, fallbackParent) => {
      if (!node) {
        return;
      }
      const placeholder = identityPlaceholderMap.get(node);
      if (placeholder?.parentElement) {
        placeholder.parentElement.insertAdjacentElement('afterend', node);
      } else if (fallbackParent) {
        fallbackParent.insertBefore(node, fallbackParent.firstChild || null);
      }
      if (placeholder) {
        placeholder.remove();
        identityPlaceholderMap.delete(node);
      }
      node.classList.remove(`${PANEL_CLASS}__identity-row`);
    };

    const actionsPlaceholderMap = new WeakMap();

    const ensureActionsPlaceholder = (node) => {
      if (!node || actionsPlaceholderMap.has(node)) {
        return actionsPlaceholderMap.get(node) || null;
      }
      const placeholder = document.createElement('div');
      placeholder.className = 'sleeper-plus-actions-placeholder';
      placeholder.style.display = 'none';
      if (node.parentElement) {
        node.parentElement.insertBefore(placeholder, node);
      }
      actionsPlaceholderMap.set(node, placeholder);
      return placeholder;
    };

    const restoreActionsRow = (node, fallbackParent) => {
      if (!node) {
        return;
      }
      const placeholder = actionsPlaceholderMap.get(node);
      if (placeholder?.parentElement) {
        placeholder.parentElement.insertAdjacentElement('afterend', node);
      } else if (fallbackParent) {
        fallbackParent.appendChild(node);
      }
      if (placeholder) {
        placeholder.remove();
        actionsPlaceholderMap.delete(node);
      }
      node.classList.remove(`${PANEL_CLASS}__actions-row`);
    };

    const getPanelRefs = () => {
      const host = resolvePanelHost();
      if (!host) {
        panelRefs = null;
        return null;
      }
      host.classList.add(USER_TAB_HOST_CLASS);
      const renderPanelSkeleton = (target) => {
        target.innerHTML = `
          <div class="${PANEL_CLASS}__shell">
            <div class="${PANEL_CLASS}__identity">
              <div class="${IDENTITY_SLOT_CLASS}"></div>
              <div class="${PANEL_CLASS}__heading-row">
                <div class="${PANEL_CLASS}__heading-cluster">
                  <div class="${PANEL_CLASS}__heading">
                    <div class="${PANEL_CLASS}__header">Total Points</div>
                    <div class="${PANEL_CLASS}__week"></div>
                  </div>
                  <div class="${PANEL_CLASS}__stats"></div>
                </div>
              </div>
            </div>
            <div class="${PANEL_CLASS}__content">
              <div class="${PANEL_CLASS}__stack" role="status" aria-live="polite">
                <div class="${PANEL_CLASS}__body"></div>
                <div class="${PANEL_CLASS}__footer">
                  <div class="${PANEL_CLASS}__footer-actions">
                    <div class="${PANEL_CLASS}__actions" aria-label="Sleeper actions"></div>
                  </div>
                  <div class="${PANEL_CLASS}__footer-left">
                    <div class="${TEAM_TOTALS_ERROR_CLASS}" aria-live="assertive">
                      <span class="${TEAM_TOTALS_ERROR_TEXT_CLASS}"></span>
                    </div>
                    <div class="${PANEL_CLASS}__meta"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="${PANEL_CLASS}__spinner" aria-hidden="true"></div>
        `;
      };

      let panel = document.getElementById(PANEL_ID);
      if (!panel) {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = PANEL_CLASS;
        renderPanelSkeleton(panel);
      } else if (!panel.querySelector(`.${PANEL_CLASS}__shell`)) {
        const existingIdentityRow = panel.querySelector(`.${PANEL_CLASS}__identity-row`);
        if (existingIdentityRow) {
          restoreIdentityRow(existingIdentityRow, panel.parentElement || panel);
        }
        const existingActionsRow = panel.querySelector(`.${PANEL_CLASS}__actions-row`);
        if (existingActionsRow) {
          restoreActionsRow(existingActionsRow, panel.parentElement || panel);
        }
        renderPanelSkeleton(panel);
      }
      const primaryRow =
        Array.from(host.children || []).find((child) => child instanceof Element && child.classList.contains('row')) || host;
      primaryRow.classList.add(USER_TAB_ROW_CLASS);
      let actionsRow =
        (panelRefs?.actionsRow && panelRefs.actionsRow.isConnected ? panelRefs.actionsRow : null) ||
        Array.from(primaryRow.children || []).find(
          (child) => child instanceof Element && child.classList.contains('actions')
        );
      const identityContainer = panel.querySelector(`.${PANEL_CLASS}__identity`);
      const identitySlot = identityContainer
        ? identityContainer.querySelector(`.${IDENTITY_SLOT_CLASS}`)
        : null;
      let identityRow = panel.querySelector(`.${PANEL_CLASS}__identity .row`);
      if (!identityRow) {
        identityRow = Array.from(primaryRow.children || []).find(
          (child) =>
            child instanceof Element &&
            child !== primaryRow &&
            child.classList.contains('row') &&
            !child.classList.contains(USER_TAB_ROW_CLASS)
        );
      }
      if (!panel.isConnected || panel.parentElement !== primaryRow) {
        if (actionsRow && actionsRow.parentElement === primaryRow) {
          actionsRow.insertAdjacentElement('beforebegin', panel);
        } else {
          primaryRow.appendChild(panel);
        }
      }
      if (identityContainer) {
        const identityTarget = identitySlot || identityContainer;
        if (identityRow) {
          identityContainer.classList.remove(`${PANEL_CLASS}__identity--hidden`);
          identityRow.classList.add(`${PANEL_CLASS}__identity-row`);
          if (identityRow.parentElement !== identityTarget) {
            ensureIdentityPlaceholder(identityRow);
            identityTarget.innerHTML = '';
            identityTarget.appendChild(identityRow);
          }
        } else {
          identityContainer.classList.add(`${PANEL_CLASS}__identity--hidden`);
          identityTarget.innerHTML = '';
        }
      }
      const actionsContainer = panel.querySelector(`.${PANEL_CLASS}__actions`);
      if (actionsContainer) {
        if (actionsRow) {
          actionsContainer.classList.remove(`${PANEL_CLASS}__actions--hidden`);
          actionsRow.classList.add(`${PANEL_CLASS}__actions-row`);
          ensureActionsPlaceholder(actionsRow);
          if (actionsRow.parentElement !== actionsContainer) {
            actionsContainer.innerHTML = '';
            actionsContainer.appendChild(actionsRow);
          }
        } else {
          actionsContainer.classList.add(`${PANEL_CLASS}__actions--hidden`);
          actionsContainer.innerHTML = '';
        }
      }
      if (typeof injectSettingsButton === 'function') {
        window.requestAnimationFrame(() => injectSettingsButton());
      }
      if (!panelRefs || panelRefs.panel !== panel) {
        panelRefs = {
          host,
          row: primaryRow,
          panel,
          week: panel.querySelector(`.${PANEL_CLASS}__week`),
          identity: identityContainer,
          identityRow,
          actions: actionsContainer,
          actionsRow,
          body: panel.querySelector(`.${PANEL_CLASS}__body`),
          stats: panel.querySelector(`.${PANEL_CLASS}__stats`),
          footer: panel.querySelector(`.${PANEL_CLASS}__meta`),
          errorContainer: panel.querySelector(`.${TEAM_TOTALS_ERROR_CLASS}`),
          error: panel.querySelector(`.${TEAM_TOTALS_ERROR_TEXT_CLASS}`),
          spinner: panel.querySelector(`.${PANEL_CLASS}__spinner`),
        };
      } else {
        panelRefs.host = host;
        panelRefs.row = primaryRow;
        panelRefs.spinner = panel.querySelector(`.${PANEL_CLASS}__spinner`);
        panelRefs.identity = identityContainer;
        panelRefs.identityRow = identityRow;
        panelRefs.actions = actionsContainer;
        panelRefs.actionsRow = actionsRow;
        panelRefs.stats = panel.querySelector(`.${PANEL_CLASS}__stats`);
        panelRefs.week = panel.querySelector(`.${PANEL_CLASS}__week`);
        panelRefs.body = panel.querySelector(`.${PANEL_CLASS}__body`);
        panelRefs.footer = panel.querySelector(`.${PANEL_CLASS}__meta`);
        panelRefs.errorContainer = panel.querySelector(`.${TEAM_TOTALS_ERROR_CLASS}`);
        panelRefs.error = panel.querySelector(`.${TEAM_TOTALS_ERROR_TEXT_CLASS}`);
      }
      return panelRefs;
    };

    const removePanel = () => {
      if (panelRefs?.identityRow) {
        restoreIdentityRow(panelRefs.identityRow, panelRefs.row || panelRefs.host || null);
      }
      if (panelRefs?.actionsRow) {
        restoreActionsRow(panelRefs.actionsRow, panelRefs.row || panelRefs.host || null);
      }
      if (panelRefs?.panel) {
        panelRefs.panel.remove();
      }
      if (panelRefs?.row) {
        panelRefs.row.classList.remove(USER_TAB_ROW_CLASS);
      }
      if (panelRefs?.host) {
        panelRefs.host.classList.remove(USER_TAB_HOST_CLASS);
      }
      panelRefs = null;
      lastRenderedTotals = null;
      if (typeof injectSettingsButton === 'function') {
        window.requestAnimationFrame(() => injectSettingsButton());
      }
    };

    const setPanelHidden = (hidden) => {
      const refs = getPanelRefs();
      if (!refs) {
        return;
      }
      refs.panel.classList.toggle(PANEL_HIDDEN_CLASS, Boolean(hidden));
    };

    const setPanelLoading = (loading) => {
      const refs = getPanelRefs();
      if (!refs) {
        return;
      }
      refs.panel.classList.toggle(PANEL_LOADING_CLASS, Boolean(loading));
    };

    const formatPoints = (value) => {
      if (!Number.isFinite(value)) {
        return '—';
      }
      return Number(value).toFixed(2);
    };

    const buildRow = (labelText, value, variant) => {
      const row = document.createElement('div');
      row.className = `${PANEL_CLASS}__row`;
      if (variant) {
        row.dataset.variant = variant;
      }

      const label = document.createElement('span');
      label.className = `${PANEL_CLASS}__label`;
      label.textContent = labelText;
      row.appendChild(label);

      const ours = document.createElement('span');
      ours.className = `${PANEL_CLASS}__value`;
      ours.textContent = formatPoints(value);
      row.appendChild(ours);

      return row;
    };

    const renderPlaceholder = (message, { week, preserveStats } = {}) => {
      const refs = getPanelRefs();
      if (!refs) {
        return;
      }
      setWeekLabel(Number.isFinite(week) ? week : getDisplayWeekNumber(), refs);
      const shouldPreserve = Boolean(preserveStats && lastRenderedTotals);
      if (refs.stats && !shouldPreserve) {
        refs.stats.innerHTML = '';
        if (message) {
          const placeholder = document.createElement('div');
          placeholder.className = `${PANEL_CLASS}__placeholder`;
          placeholder.textContent = message;
          refs.stats.appendChild(placeholder);
        }
      }
      if (refs.footer && !shouldPreserve) {
        refs.footer.textContent = '';
      }
      if (refs.error) {
        refs.error.textContent = message || '';
      }
      if (!shouldPreserve && !message && refs.error) {
        refs.error.textContent = '';
      }
      if (!shouldPreserve) {
        lastRenderedTotals = null;
      }
    };

    const shouldMirrorProjection = (weekNumber) => {
      const apiWeekNumber = getApiWeekNumber();
      return Number.isFinite(apiWeekNumber) && Number.isFinite(weekNumber) && weekNumber < apiWeekNumber;
    };

    const adjustTeamTotalsForWeek = (team, weekNumber) => {
      if (!team) {
        return null;
      }
      if (shouldMirrorProjection(weekNumber)) {
        return { ...team, projected: team.actual };
      }
      return team;
    };

    const renderTotals = (payload, context) => {
      const refs = getPanelRefs();
      if (!refs) {
        return;
      }
      setPanelHidden(false);
      if (refs.error) {
        refs.error.textContent = '';
      }
      const displayWeek = Number.isFinite(context?.displayWeek)
        ? context.displayWeek
        : Number.isFinite(payload?.week)
        ? payload.week
        : getDisplayWeekNumber();
      setWeekLabel(displayWeek, refs);
      const teamTotals = adjustTeamTotalsForWeek(payload?.team, displayWeek);
      const hasTotals = teamTotals && (teamTotals.actual !== null || teamTotals.projected !== null);
      if (refs.stats) {
        refs.stats.innerHTML = '';
        if (hasTotals) {
          refs.stats.appendChild(buildRow('Actual', teamTotals.actual, 'actual'));
          refs.stats.appendChild(buildRow('Projected', teamTotals.projected, 'projected'));
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = `${PANEL_CLASS}__placeholder`;
          placeholder.textContent = 'Totals unavailable for this roster.';
          refs.stats.appendChild(placeholder);
        }
      }
      let footerText = '';
      if (refs.footer) {
        const starterCount = teamTotals?.starterCount ?? 0;
        const timestamp = payload?.generatedAt
          ? new Date(payload.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : 'just now';
        footerText = `${starterCount || 0} starters · Synced ${timestamp}`;
        refs.footer.textContent = footerText;
      }
      lastRenderedTotals = hasTotals
        ? {
            displayWeek,
            footer: footerText,
            team: teamTotals,
          }
        : null;
      if (!hasTotals && payload?.error) {
        renderError(payload.error, { week: displayWeek });
      }
    };

    const renderError = (message, { week } = {}) => {
      const refs = getPanelRefs();
      if (!refs) {
        return;
      }
      setWeekLabel(Number.isFinite(week) ? week : getDisplayWeekNumber(), refs);
      if (refs.stats) {
        refs.stats.innerHTML = '';
      }
      if (refs.footer) {
        refs.footer.textContent = '';
      }
      if (refs.error) {
        refs.error.textContent = message || 'Sleeper+ totals unavailable';
      }
      lastRenderedTotals = null;
    };

    const resolveRequestedWeekNumber = () => {
      const selected = getSelectedWeekNumber();
      if (Number.isFinite(selected)) {
        return selected;
      }
      const detected = detectDisplayedWeekNumber();
      if (withinWeekBounds(detected)) {
        return setSelectedWeek(detected, { notify: false });
      }
      return getApiWeekNumber();
    };

    const buildRequestContext = () => {
      if (!leagueId) {
        return null;
      }
      const resolvedWeek = resolveRequestedWeekNumber();
      const requestWeek = Number.isFinite(resolvedWeek) ? Number(resolvedWeek) : undefined;
      const displayWeek = Number.isFinite(resolvedWeek) ? Number(resolvedWeek) : null;
      const shouldInferStarters = !rosterId;
      const playerIds = shouldInferStarters ? collectRosterPlayerIds() : [];
      if (!rosterId && playerIds.length === 0) {
        return null;
      }
      const starterKey = shouldInferStarters && playerIds.length > 0 ? `players:${playerIds.join(',')}` : 'roster';
      return {
        leagueId,
        rosterId,
        week: requestWeek,
        displayWeek,
        playerIds,
        signature: `${leagueId}:${rosterId || 'none'}:${requestWeek ?? 'auto'}:${starterKey}`,
      };
    };

    const scheduleRefresh = ({ force = false } = {}) => {
      if (!running) {
        return;
      }
      pendingForceRefresh = pendingForceRefresh || force;
      if (refreshScheduled) {
        return;
      }
      refreshScheduled = true;
      window.requestAnimationFrame(() => {
        refreshScheduled = false;
        const shouldForce = pendingForceRefresh;
        pendingForceRefresh = false;
        runTotalsRefresh({ force: shouldForce });
      });
    };

    const runTotalsRefresh = ({ force = false } = {}) => {
      if (!running || !leagueId) {
        return;
      }
      const context = buildRequestContext();
      if (!context) {
        renderPlaceholder('Open your roster to view totals', { week: getDisplayWeekNumber() });
        return;
      }
      if (!force && context.signature === lastContextSignature) {
        return;
      }
      lastContextSignature = context.signature;
      const requestId = ++inflightRequestId;
      setPanelHidden(false);
      setPanelLoading(true);
      renderPlaceholder('', { week: context.displayWeek, preserveStats: Boolean(lastRenderedTotals) });

      sendRuntimeMessage(
        {
          type: 'SLEEPER_PLUS_GET_TEAM_TOTALS',
          leagueId: context.leagueId,
          rosterId: context.rosterId,
          week: context.week,
          playerIds: context.playerIds,
        },
        'team totals'
      )
        .then((result) => {
          if (requestId !== inflightRequestId) {
            return;
          }
          if (!rosterId && result?.team?.rosterId) {
            rosterId = String(result.team.rosterId);
          }
          renderTotals(result, context);
        })
        .catch((error) => {
          if (requestId !== inflightRequestId) {
            return;
          }
          renderError(error.message || 'Sleeper+ totals unavailable', {
            week: context?.displayWeek ?? getDisplayWeekNumber(),
          });
        })
        .finally(() => {
          if (requestId === inflightRequestId) {
            setPanelLoading(false);
          }
        });
    };

    const handleRosterMutations = (mutations) => {
      const shouldRefresh = mutations.some((mutation) => {
        if (mutation.type !== 'childList') {
          return false;
        }
        return (
          Array.from(mutation.addedNodes || []).some((node) => node instanceof Element && node.classList.contains('team-roster-item')) ||
          Array.from(mutation.removedNodes || []).some((node) => node instanceof Element && node.classList.contains('team-roster-item'))
        );
      });
      if (shouldRefresh) {
        scheduleRefresh({ force: true });
      }
    };

    const handleLineupInteraction = (event) => {
      if (!running) {
        return;
      }
      const target = event?.target instanceof Element ? event.target.closest('.team-roster') : null;
      if (!target) {
        return;
      }
      window.setTimeout(() => scheduleRefresh({ force: true }), 200);
    };

    const attachInteractionListeners = () => {
      if (interactionListenerAttached) {
        return;
      }
      LINEUP_INTERACTION_EVENTS.forEach((eventName) => {
        document.addEventListener(eventName, handleLineupInteraction, true);
      });
      interactionListenerAttached = true;
    };

    const detachInteractionListeners = () => {
      if (!interactionListenerAttached) {
        return;
      }
      LINEUP_INTERACTION_EVENTS.forEach((eventName) => {
        document.removeEventListener(eventName, handleLineupInteraction, true);
      });
      interactionListenerAttached = false;
    };

    const disconnectRosterObserver = () => {
      if (rosterObserver) {
        rosterObserver.disconnect();
        rosterObserver = null;
      }
      observedRoster = null;
    };

    const connectRosterObserver = (target) => {
      if (!target || observedRoster === target) {
        return false;
      }
      disconnectRosterObserver();
      rosterObserver = new MutationObserver((mutations) => {
        if (!running) {
          return;
        }
        handleRosterMutations(mutations);
      });
      rosterObserver.observe(target, { childList: true, subtree: true });
      observedRoster = target;
      return true;
    };

    const watchRosterTarget = () => {
      if (!running) {
        return;
      }
      const roster = document.querySelector('.team-roster');
      if (!roster) {
        disconnectRosterObserver();
        setPanelHidden(true);
        lastContextSignature = '';
        return;
      }
      if (connectRosterObserver(roster)) {
        scheduleRefresh({ force: true });
      }
    };

    const startRosterWatch = () => {
      if (rosterWatchInterval) {
        return;
      }
      watchRosterTarget();
      rosterWatchInterval = window.setInterval(() => watchRosterTarget(), 1500);
    };

    const stopRosterWatch = () => {
      if (rosterWatchInterval) {
        window.clearInterval(rosterWatchInterval);
        rosterWatchInterval = null;
      }
      disconnectRosterObserver();
    };

    const handleVisibilityChange = () => {
      if (!running) {
        return;
      }
      if (document.visibilityState === 'hidden') {
        stopRosterWatch();
        stopWeekWatcher();
      } else {
        startRosterWatch();
        startWeekWatcher();
        scheduleRefresh();
      }
    };

    const attachVisibilityListener = () => {
      if (visibilityListenerAttached) {
        return;
      }
      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = true;
    };

    const detachVisibilityListener = () => {
      if (!visibilityListenerAttached) {
        return;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = false;
    };

    const start = () => {
      if (running) {
        scheduleRefresh();
        return;
      }
      running = true;
      lastContextSignature = '';
      inflightRequestId += 1;
      const refs = getPanelRefs();
      setPanelHidden(false);
      if (refs) {
        setWeekLabel(getDisplayWeekNumber(), refs);
      }
      startRosterWatch();
      startWeekWatcher();
      attachVisibilityListener();
      attachInteractionListeners();
      scheduleRefresh();
    };

    const stop = () => {
      if (!running) {
        resetWeekState();
        detachInteractionListeners();
        removePanel();
        return;
      }
      running = false;
      lastContextSignature = '';
      inflightRequestId += 1;
      stopRosterWatch();
      stopWeekWatcher();
      detachVisibilityListener();
      detachInteractionListeners();
      removePanel();
    };

    const update = ({ enabled, leagueId: nextLeagueId, rosterId: nextRosterId }) => {
      const normalizedLeagueId = nextLeagueId || '';
      const normalizedRosterId = nextRosterId || '';
      const leagueChanged = leagueId !== normalizedLeagueId;
      const rosterChanged = rosterId !== normalizedRosterId;
      leagueId = normalizedLeagueId;
      rosterId = normalizedRosterId;
      if (leagueChanged || rosterChanged) {
        resetWeekState();
        lastContextSignature = '';
      }
      if (leagueId) {
        syncWeekFromService();
      }
      if (enabled && leagueId) {
        start();
      } else {
        stop();
      }
    };

    const refresh = () => {
      if (running) {
        scheduleRefresh();
      }
    };

    return { update, refresh, stop };
  })();

  const detachHeaderSettingsParent = () => {
    if (headerSettingsParent) {
      headerSettingsParent.classList.remove(SETTINGS_PARENT_CLASS);
      headerSettingsParent = null;
    }
  };

  const buildSettingsButton = () => {
    const container = document.createElement('div');
    container.id = BUTTON_CONTAINER_ID;
    container.className = `${ENTRY_CLASS} sleeper-plus-settings-entry`;
    container.dataset.placement = 'header';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.title = 'Sleeper+ Settings';
    button.setAttribute('aria-label', 'Open Sleeper+ settings');
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"
          fill="currentColor"
        />
      </svg>`;

    button.addEventListener('click', (event) => {
      event.preventDefault();
      openSleeperPlusSettings();
    });

    const buttonWrapper = document.createElement('div');
    buttonWrapper.className = 'sleeper-plus-settings-button-shell';
    buttonWrapper.appendChild(button);

    const label = document.createElement('div');
    label.className = 'btn-text sleeper-plus-settings-label';
    label.textContent = 'Sleeper+';

    container.appendChild(buttonWrapper);
    container.appendChild(label);
    return container;
  };

  const resolveSettingsButtonTarget = () => {
    const actionsRow = document.querySelector('.sleeper-plus-team-totals__actions-row');
    if (actionsRow) {
      return { placement: 'actions', parent: actionsRow };
    }
    const headerAnchor = document.querySelector('.settings-header-container');
    if (headerAnchor && headerAnchor.parentElement) {
      return { placement: 'header', parent: headerAnchor.parentElement, reference: headerAnchor };
    }
    return null;
  };

  const injectSettingsButton = () => {
    if (!shouldDisplaySettingsButton()) {
      detachHeaderSettingsParent();
      return false;
    }

    const target = resolveSettingsButtonTarget();
    if (!target) {
      return false;
    }

    let container = document.getElementById(BUTTON_CONTAINER_ID);
    if (!container) {
      container = buildSettingsButton();
    }

    container.dataset.placement = target.placement;

    if (target.placement === 'actions') {
      detachHeaderSettingsParent();
      container.classList.add('action', 'btn-container', 'space');
      if (container.parentElement !== target.parent || container !== target.parent.lastElementChild) {
        target.parent.appendChild(container);
      }
      // Remove injected helper spacing and tighten the actions row gap so
      // buttons sit closer together and align vertically.
      try {
        container.classList.remove('space');
        // Set a moderate outer gap for the actions row, then ensure each
        // action child uses a compact vertical gap so the label sits near
        // its button (matching the Sleeper+ appearance).
        target.parent.style.gap = '18px';
        target.parent.style.columnGap = '18px';
        target.parent.style.alignItems = 'center';
        Array.from(target.parent.children).forEach((sib) => {
          try {
            if (sib !== container && (sib.tagName === 'BUTTON' || sib.classList.contains('button') || sib.classList.contains('btn') || sib.classList.contains('btn-container') || sib.classList.contains('action'))) {
              sib.style.margin = '0';
              sib.style.padding = sib.style.padding || '0';
              sib.style.alignSelf = 'center';
              // Ensure vertical stacking and a compact gap between the
              // button and its label (some site markup uses flex column).
              sib.style.display = sib.style.display || 'inline-flex';
              sib.style.flexDirection = 'column';
              sib.style.gap = '6px';
              sib.style.alignItems = 'center';

              // If the label is a known class, tighten its margin to match
              // the injected Sleeper+ label spacing.
              const label = sib.querySelector('.btn-text, .button-text, .btn-label, .label, .btn__text');
              if (label) {
                label.style.margin = '0';
                label.style.marginTop = '6px';
              }
            }
          } catch (_) {}
        });
      } catch (_) {}
      // Attempt to mirror the site's trade button appearance exactly by
      // copying class names and key computed visual styles from a nearby
      // trade/action button in the same actions container. This allows the
      // injected Sleeper+ button to match size, hover, and other visual
      // cues without needing brittle CSS duplication.
      try {
        const candidates = Array.from(target.parent.querySelectorAll('button, .button, .btn'));
        let found = candidates.find((el) => /trade/i.test((el.textContent || '').trim()));
        if (!found && candidates.length) {
          found = candidates[0];
        }
        if (found) {
          const wrapper = container.querySelector('.sleeper-plus-settings-button-shell');
          const inner = container.querySelector(`.${BUTTON_CLASS}`);
          // Copy class list from the reference button to our wrapper so
          // site CSS (including :hover rules) applies automatically.
          try {
            found.classList.forEach((c) => {
              if (!c) return;
              // Avoid copying layout-specific classes that would move the node
              // itself (keep visual styling classes only). This is conservative;
              // if a class causes unexpected behavior we'll remove it later.
              wrapper.classList.add(c);
            });
          } catch (_) {}

          // Copy a few key computed styles to ensure exact sizing when site
          // uses inline or computed values rather than only classes.
          const cs = window.getComputedStyle(found);
          if (wrapper) {
            wrapper.style.width = cs.width;
            wrapper.style.height = cs.height;
            wrapper.style.borderRadius = cs.borderRadius;
            wrapper.style.border = cs.border;
            wrapper.style.background = cs.background;
            wrapper.style.boxShadow = cs.boxShadow;
            wrapper.style.transition = cs.transition;
            wrapper.style.padding = cs.padding;
          }

          // Tighten spacing for the actions placement so the injected button
          // aligns vertically with neighboring action buttons and doesn't
          // introduce large gaps. We apply conservative inline styles here
          // to override any parent layout spacing that affects only this
          // injected container.
          try {
            container.style.margin = '0';
            container.style.minWidth = '48px';
            container.style.width = 'auto';
            container.style.display = 'inline-flex';
            container.style.flexDirection = 'column';
            container.style.gap = '9px';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'center';
            container.style.alignSelf = 'center';
            // also ensure the wrapper aligns and doesn't add extra spacing
            if (wrapper) {
              wrapper.style.margin = '0';
              wrapper.style.boxSizing = 'border-box';
            }
          } catch (_) {}

          // Copy SVG sizing if present on the reference button
          const refSvg = found.querySelector('svg');
          const ourSvg = container.querySelector('svg');
          if (refSvg && ourSvg) {
            const rcs = window.getComputedStyle(refSvg);
            ourSvg.style.width = refSvg.getAttribute('width') || rcs.width || refSvg.style.width || '20px';
            ourSvg.style.height = refSvg.getAttribute('height') || rcs.height || refSvg.style.height || '20px';
          }
        }
      } catch (e) {
        // Non-fatal: if anything fails here we still show the default button
        // styling defined elsewhere in the extension.
      }
    } else {
      container.classList.remove('action', 'btn-container', 'space');
      if (headerSettingsParent !== target.parent) {
        detachHeaderSettingsParent();
        headerSettingsParent = target.parent;
        headerSettingsParent.classList.add(SETTINGS_PARENT_CLASS);
      }
      if (container.parentElement !== target.parent || container.nextElementSibling !== target.reference) {
        target.parent.insertBefore(container, target.reference);
      }
    }

    return true;
  };

  const removeSettingsButton = () => {
    const existing = document.getElementById(BUTTON_CONTAINER_ID);
    if (existing) {
      existing.remove();
      refreshIndicatorController.remove();
    }
    detachHeaderSettingsParent();
  };

  const startSettingsObserver = () => {
    if (settingsObserver || !document.body) {
      return;
    }

    settingsObserver = new MutationObserver(() => {
      if (!shouldDisplaySettingsButton()) {
        return;
      }
      injectSettingsButton();
    });

    settingsObserver.observe(document.body, SETTINGS_OBSERVER_CONFIG);
  };

  const stopSettingsObserver = () => {
    if (settingsObserver) {
      settingsObserver.disconnect();
      settingsObserver = null;
    }
  };

  const updateSettingsButton = () => {
    if (!shouldDisplaySettingsButton()) {
      removeSettingsButton();
      if (!isActive) {
        removeStyles();
      }
      stopSettingsObserver();
      return;
    }

    startSettingsObserver();

    if (!isActive) {
      applyButtonOnlyStyles();
    }

    injectSettingsButton();
  };

  const activateExtension = () => {
    if (isActive) {
      updateLayoutStyles();
      startCenterPanelMonitor();
      return;
    }

    isActive = true;
    updateLayoutStyles();
    startCenterPanelMonitor();
  };

  const deactivateExtension = () => {
    stopCenterPanelMonitor();
    stopBodyObserver();
    if (!isActive) {
      if (shouldDisplaySettingsButton()) {
        applyButtonOnlyStyles();
      } else {
        removeStyles();
      }
      return;
    }

    isActive = false;

    if (shouldDisplaySettingsButton()) {
      applyButtonOnlyStyles();
    } else {
      removeStyles();
    }
  };

  const evaluateActivation = () => {
    updateSettingsButton();

    if (disableSleeperPlus) {
      deactivateExtension();
      return;
    }

    if (!isLeaguePath() || leagueIds.length === 0) {
      deactivateExtension();
      return;
    }

    if (doesUrlMatchLeague()) {
      activateExtension();
    } else {
      deactivateExtension();
    }

    const activeLeagueId = getCurrentLeagueId();
    const shouldRunTrends = isActive && Boolean(activeLeagueId);
    trendOverlayManager.update({ enabled: shouldRunTrends, leagueId: shouldRunTrends ? activeLeagueId : '' });
    if (shouldRunTrends) {
      trendOverlayManager.refresh();
    }

    const activeRosterId = getCurrentRosterId();
    const shouldRunTotals = isActive && isTeamView() && Boolean(activeLeagueId) && showTeamTotals;
    teamTotalsController.update({
      enabled: shouldRunTotals,
      leagueId: shouldRunTotals ? activeLeagueId : '',
      rosterId: shouldRunTotals ? activeRosterId : '',
    });
    if (shouldRunTotals) {
      teamTotalsController.refresh();
    }
  };

  const handleUrlChange = () => {
    const href = window.location.href;
    if (href === currentBaseUrl) {
      return;
    }
    currentBaseUrl = href;
    evaluateActivation();
  };

  const watchHistoryChanges = () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushStateWrapper(...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(handleUrlChange, 0);
      return result;
    };

    history.replaceState = function replaceStateWrapper(...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(handleUrlChange, 0);
      return result;
    };

    window.addEventListener('popstate', () => setTimeout(handleUrlChange, 0));
    window.addEventListener('hashchange', () => setTimeout(handleUrlChange, 0));
  };

  const startBodyObserver = () => {
    if (bodyObserver || !document.body) return;
    bodyObserver = new MutationObserver((mutations) => {
      let foundRosterChange = false;
      for (let i = 0; i < mutations.length; i += 1) {
        const m = mutations[i];
        if (m.type !== 'childList') continue;
        const nodes = Array.from(m.addedNodes || []).concat(Array.from(m.removedNodes || []));
        for (let j = 0; j < nodes.length; j += 1) {
          const node = nodes[j];
          if (!(node instanceof Element)) continue;
          if (node.matches && node.matches('.team-roster')) {
            foundRosterChange = true;
            break;
          }
          if (node.querySelector && node.querySelector('.team-roster')) {
            foundRosterChange = true;
            break;
          }
        }
        if (foundRosterChange) break;
      }
      if (foundRosterChange) {
        // Re-evaluate activation so the totals controller can attach when roster appears
        try {
          evaluateActivation();
        } catch (e) {
          // non-fatal
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  };

  const stopBodyObserver = () => {
    if (!bodyObserver) return;
    bodyObserver.disconnect();
    bodyObserver = null;
  };

  const initialize = async () => {
    const stored = await getStoredSettings();
    leagueIds = stored.leagueIds;
    chatMaxWidth = stored.chatMaxWidth;
    showSettingsButton = stored.showSettingsButton;
    disableSleeperPlus = stored.disableSleeperPlus;
    enableTrendOverlays = stored.enableTrendOverlays;
    showOpponentRanks = stored.showOpponentRanks;
    showSparklineAlways = stored.showSparklineAlways;
    showTeamTotals = stored.showTeamTotals;
    enableNavbarOverride = stored.enableNavbarOverride;

    evaluateActivation();
    currentBaseUrl = window.location.href;
    watchHistoryChanges();
    startBodyObserver();
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') {
      return;
    }

    let shouldEvaluate = false;

    if (Object.prototype.hasOwnProperty.call(changes, 'leagueIds')) {
      const nextLeagueIds = sanitizeLeagueIds(changes.leagueIds.newValue);
      if (!areLeagueListsEqual(leagueIds, nextLeagueIds)) {
        leagueIds = nextLeagueIds;
        shouldEvaluate = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(changes, 'leagueId')) {
      const nextLeagueIds = sanitizeLeagueIds(changes.leagueId.newValue);
      if (!areLeagueListsEqual(leagueIds, nextLeagueIds)) {
        leagueIds = nextLeagueIds;
        shouldEvaluate = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'chatMaxWidth')) {
      chatMaxWidth = sanitizeChatWidth(changes.chatMaxWidth.newValue);
      if (isActive) {
        updateLayoutStyles();
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'showSettingsButton')) {
      const nextShowSettingsButton =
        typeof changes.showSettingsButton.newValue === 'boolean'
          ? changes.showSettingsButton.newValue
          : DEFAULT_SHOW_SETTINGS_BUTTON;

      if (showSettingsButton !== nextShowSettingsButton) {
        showSettingsButton = nextShowSettingsButton;
        shouldEvaluate = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'disableSleeperPlus')) {
      const nextDisable =
        typeof changes.disableSleeperPlus.newValue === 'boolean'
          ? changes.disableSleeperPlus.newValue
          : DEFAULT_SETTINGS.disableSleeperPlus;

      if (disableSleeperPlus !== nextDisable) {
        disableSleeperPlus = nextDisable;
        shouldEvaluate = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'enableTrendOverlays')) {
      const nextEnable =
        typeof changes.enableTrendOverlays.newValue === 'boolean'
          ? changes.enableTrendOverlays.newValue
          : DEFAULT_ENABLE_TREND_OVERLAYS;

      if (enableTrendOverlays !== nextEnable) {
        enableTrendOverlays = nextEnable;
        shouldEvaluate = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'showOpponentRanks')) {
      const nextShowOpponentRanks =
        typeof changes.showOpponentRanks.newValue === 'boolean'
          ? changes.showOpponentRanks.newValue
          : DEFAULT_SHOW_OPPONENT_RANKS;

      if (showOpponentRanks !== nextShowOpponentRanks) {
        showOpponentRanks = nextShowOpponentRanks;
        trendOverlayManager.refresh();
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'showSparklineAlways')) {
      const nextShowSparklineAlways =
        typeof changes.showSparklineAlways.newValue === 'boolean'
          ? changes.showSparklineAlways.newValue
          : DEFAULT_SHOW_SPARKLINE_ALWAYS;

      if (showSparklineAlways !== nextShowSparklineAlways) {
        showSparklineAlways = nextShowSparklineAlways;
        trendOverlayManager.refresh();
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'showTeamTotals')) {
      const nextShowTeamTotals =
        typeof changes.showTeamTotals.newValue === 'boolean'
          ? changes.showTeamTotals.newValue
          : DEFAULT_SHOW_TEAM_TOTALS;

      if (showTeamTotals !== nextShowTeamTotals) {
        showTeamTotals = nextShowTeamTotals;
        shouldEvaluate = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'enableNavbarOverride')) {
      const nextEnableNavbarOverride =
        typeof changes.enableNavbarOverride.newValue === 'boolean'
          ? changes.enableNavbarOverride.newValue
          : DEFAULT_ENABLE_NAVBAR_OVERRIDE;

      if (enableNavbarOverride !== nextEnableNavbarOverride) {
        enableNavbarOverride = nextEnableNavbarOverride;
        if (isActive) {
          updateLayoutStyles();
        } else if (shouldDisplaySettingsButton()) {
          applyButtonOnlyStyles();
        } else {
          removeStyles();
        }
      }
    }

    if (shouldEvaluate) {
      evaluateActivation();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
