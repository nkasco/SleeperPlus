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
  const SETTINGS_OBSERVER_CONFIG = { childList: true, subtree: true };

  const DEFAULT_CHAT_MAX_WIDTH = 400;
  const DEFAULT_SHOW_SETTINGS_BUTTON = true;
  const DEFAULT_DISABLE_SLEEPER_PLUS = false;
  const DEFAULT_ENABLE_TREND_OVERLAYS = true;
  const DEFAULT_SHOW_OPPONENT_RANKS = true;
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
  };

  let leagueIds = [];
  let chatMaxWidth = DEFAULT_CHAT_MAX_WIDTH;
  let showSettingsButton = DEFAULT_SHOW_SETTINGS_BUTTON;
  let disableSleeperPlus = DEFAULT_DISABLE_SLEEPER_PLUS;
  let enableTrendOverlays = DEFAULT_ENABLE_TREND_OVERLAYS;
  let showOpponentRanks = DEFAULT_SHOW_OPPONENT_RANKS;
  let isActive = false;
  let settingsObserver = null;
  let currentBaseUrl = '';
  let centerPanelResizeObserver = null;
  let observedCenterPanel = null;
  let centerPanelWatchIntervalId = null;
  let windowResizeListenerAttached = false;
  let pendingCenterPanelResizeFrame = null;
  let isCenterPanelCompact = false;

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

    const ensureIndicatorNode = () => {
      if (!shouldDisplaySettingsButton()) {
        return null;
      }
      const buttonContainer = document.getElementById(BUTTON_CONTAINER_ID);
      if (!buttonContainer || !buttonContainer.parentElement) {
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
      if (indicatorNode.parentElement !== buttonContainer.parentElement) {
        buttonContainer.parentElement.insertBefore(indicatorNode, buttonContainer);
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
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      #${BUTTON_CONTAINER_ID}.${ENTRY_CLASS} {
        padding: 0;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 1.4rem;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        transition: color 0.15s ease-in-out, text-shadow 0.15s ease-in-out;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:hover,
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:focus-visible {
        background: transparent;
        outline: none;
        text-shadow: 0 0 6px rgba(255, 255, 255, 0.35);
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:focus-visible {
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:active {
        transform: none;
      }
      .${REFRESH_INDICATOR_CLASS} {
        font-size: 0.92rem;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.85);
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        min-height: 32px;
      }
      .${REFRESH_INDICATOR_CLASS}.${REFRESH_INDICATOR_HIDDEN_CLASS} {
        display: none !important;
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
      .sleeper-plus-trend__chart svg {
        width: 100%;
        height: 48px;
      }
      .sleeper-plus-trend__chart polygon {
        fill: rgba(255, 255, 255, 0.04);
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
        stroke: #ef4444;
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
        fill: #ef4444;
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
    style.textContent = getButtonStyleBlock();
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

    const buttonStyles = shouldDisplaySettingsButton() ? getButtonStyleBlock() : '';
    const trendStyles = enableTrendOverlays ? getTrendStyleBlock() : '';
     const compactStyles = enableTrendOverlays
      ? `.${COMPACT_PANEL_CLASS} .sleeper-plus-trend__chart,
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
        }`
      : '';

    style.textContent = `${layoutStyles}${buttonStyles}${trendStyles}${compactStyles}`;
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
    const DATASET_PLAYER_ID = 'sleeperPlusPlayerId';
    const DATASET_STATE = 'sleeperPlusTrendState';
    const DATASET_WEEK = 'sleeperPlusWeek';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const WEEK_ACTIVE_SELECTORS = [
      '[data-testid*="week"][aria-pressed="true"]',
      '[data-testid*="week"][data-selected="true"]',
      '.week-selector [aria-pressed="true"]',
      '.week-selector button.is-selected',
      '.week-selector button.selected',
      '.week-selector .selected',
      '.week-selector .selected-option',
      '.week-select__option.is-selected',
      '.week-select__option[aria-current="true"]',
      '.week-select__option[aria-selected="true"]',
    ];
    const WEEK_FALLBACK_SELECTOR =
      '[data-week],[data-leg],[data-testid*="week" i],[class*="week" i],[aria-label*="week" i],[title*="week" i]';
    const WEEK_CLICK_TARGET_SELECTOR =
      '[data-testid*="week"],.week-selector button,.week-select__option,[class*="week-selector"] button';
    const WEEK_POLL_INTERVAL_MS = 1200;

    const processingMap = new WeakMap();
    const trendCache = new Map();
    const inflightTrends = new Map();
    const lookupCache = new Map();
    const inflightLookups = new Map();

    let leagueId = '';
    let running = false;
    let activeWeek = null;
    let rosterObserver = null;
    let observedRoster = null;
    let rosterWatchInterval = null;
    let scanScheduled = false;
    let visibilityListenerAttached = false;
    let weekPollIntervalId = null;
    let weekClickListenerAttached = false;
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

    const getCurrentWeekNumber = () => (Number.isFinite(activeWeek) ? activeWeek : null);
    const getCurrentWeekKey = () => (Number.isFinite(activeWeek) ? `week-${activeWeek}` : 'auto');
    const buildTrendCacheKey = (playerId, weekKey) => {
      const resolvedWeekKey = weekKey || getCurrentWeekKey();
      return `${leagueId}:${resolvedWeekKey}:${playerId}`;
    };

    const sendRuntimeRequest = (message, label) =>
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
      const request = sendRuntimeRequest(
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

      const request = sendRuntimeRequest(payload, 'trend request')
        .then((result) => {
          inflightTrends.delete(cacheKey);
          trendCache.set(cacheKey, result);
          return result;
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
      });
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

    const getMatchupToneClass = (rank, scale) => {
      if (!Number.isFinite(rank) || !Number.isFinite(scale) || scale <= 0) {
        return 'matchup-neutral';
      }
      const percentile = rank / scale;
      if (percentile <= 1 / 3) {
        return 'matchup-good';
      }
      if (percentile >= 2 / 3) {
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
      const toneClass = getMatchupToneClass(matchup.rank, matchup.scale || 32);
      if (toneClass) {
        wrapper.classList.add(toneClass);
      }
      const projectedAllowed = Number(matchup.projectedAllowed);
      if (Number.isFinite(projectedAllowed)) {
        const sampleText = matchup.sampleSize ? ` across ${matchup.sampleSize} player projections` : '';
        wrapper.title = `${matchup.position} vs ${matchup.opponent} projects to ${projectedAllowed.toFixed(1)} pts${sampleText}`;
      }

      const label = document.createElement('span');
      label.className = MATCHUP_LABEL_CLASS;
      label.textContent = matchup.opponent ? `vs ${matchup.opponent}` : 'Matchup';
      wrapper.appendChild(label);

      const value = document.createElement('span');
      value.className = MATCHUP_VALUE_CLASS;
      const scale = matchup.scale || 32;
      value.textContent = `${matchup.position} #${matchup.rank}/${scale}`;
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

    const extractOpponentCode = (wrapper) => {
      if (!wrapper) {
        return '';
      }
      const text = wrapper.textContent || '';
      if (!text) {
        return '';
      }
      const normalized = text.replace(/[^a-z0-9@\s]/gi, ' ').toUpperCase();
      if (normalized.includes('BYE')) {
        return '';
      }
      const match = normalized.match(/(?:VS|@)\s+([A-Z]{2,4})\b/);
      if (match && match[1]) {
        return match[1].replace(/[^A-Z]/g, '').toUpperCase();
      }
      return '';
    };

    const buildFallbackMatchup = (data, item, scheduleWrapper) => {
      if (!data?.opponentRanks) {
        return null;
      }
      const hostWrapper = scheduleWrapper || findScheduleWrapper(item);
      const opponentCode = extractOpponentCode(hostWrapper);
      if (!opponentCode) {
        return null;
      }
      const positionCandidate = data.positionRank?.position || data.matchup?.position || data.primaryPosition;
      const position = positionCandidate && positionCandidate !== 'UNK' ? positionCandidate : null;
      if (!position) {
        return null;
      }
      const ranksForPosition = data.opponentRanks[position] || data.opponentRanks[position.toUpperCase()];
      if (!ranksForPosition) {
        return null;
      }
      const normalizedOpponent = opponentCode.toUpperCase();
      const sanitizedOpponent = normalizedOpponent.replace(/[^A-Z]/g, '');
      const rankingEntry =
        ranksForPosition[normalizedOpponent] ||
        ranksForPosition[sanitizedOpponent] ||
        ranksForPosition[normalizedOpponent.replace(/^@/, '')];
      if (!rankingEntry) {
        return null;
      }
      return {
        opponent: sanitizedOpponent || normalizedOpponent,
        position,
        rank: rankingEntry.rank,
        scale: rankingEntry.scale,
        sampleSize: rankingEntry.count,
        projectedAllowed: rankingEntry.total,
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
      const hasValidOpponent =
        matchup &&
        !isByeMatchup(matchup) &&
        matchup.opponent &&
        matchup.position &&
        Number.isFinite(rankValue);

      if (!hasValidOpponent) {
        label.textContent = 'Matchup';
        value.textContent = 'Rank —';
        node.classList.add('placeholder');
        node.removeAttribute('title');
        return;
      }

      const opponentLabel = matchup.opponent.toString().trim() || '—';
      label.textContent = `vs ${opponentLabel}`;
      const scale = Number(matchup.scale) || 32;
      value.textContent = `${matchup.position} #${rankValue}/${scale}`;
      node.title = `${matchup.position} vs ${opponentLabel} ranks ${rankValue} of ${scale}`;
      const toneClass = getMatchupToneClass(rankValue, scale);
      if (toneClass) {
        node.classList.add(toneClass);
      }
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

    const buildSparklinePoints = (series, width, height) => {
      if (!series || series.length === 0) {
        return { linePoints: '', areaPoints: '', coords: [] };
      }
      const actualValues = series.map((entry) => Number(entry.points) || 0);
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
        const normalized = (Number(entry.points) - min) / range;
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

    const LINE_COLORS = {
      over: '#22c55e',
      under: '#ef4444',
      neutral: '#3b82f6',
      future: '#94a3b8',
    };

    const classifyWeek = (entry) => {
      if (!entry || entry.projected === null || entry.projected === undefined) {
        return 'neutral';
      }
      const actual = Number(entry.points) || 0;
      const projected = Number(entry.projected) || 0;
      return actual >= projected ? 'over' : 'under';
    };

    const segmentLinePoints = (coords, series) => {
      if (!coords || coords.length === 0 || !series || series.length === 0) {
        return [];
      }
      const segments = [];
      let currentClass = classifyWeek(series[0]);
      let currentPoints = [coords[0]];

      for (let index = 1; index < coords.length; index += 1) {
        const nextClass = classifyWeek(series[index]);
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
    const createSparkline = (series) => {
      if (!series || series.length === 0) {
        return null;
      }
      const width = 220;
      const height = 48;
      const { areaPoints, coords, min, range } = buildSparklinePoints(series, width, height);
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

      const segments = segmentLinePoints(actualCoords, actualSeries);
      if (segments.length === 0 && actualCoords.length > 0) {
        const fallbackClass = classifyWeek(actualSeries[0]);
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
          const classification = classifyWeek(dataPoint);
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

    const renderMessage = (item, message, { weekKey } = {}) => {
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
      if (showOpponentRanks) {
        ensureInlinePlaceholder(item, scheduleWrapper);
      }
    };

    const renderTrend = (item, data, { weekKey } = {}) => {
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

      if (showOpponentRanks) {
        const matchupData = data.matchup || buildFallbackMatchup(data, item, scheduleWrapper);
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
      const chart = createSparkline(data.weeklySeries);
      if (chart) {
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

      if (showOpponentRanks) {
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
            renderMessage(item, 'Sleeper+ trend unavailable', { weekKey: getCurrentWeekKey() });
            return;
          }
          const currentWeekKey = getCurrentWeekKey();
          if (
            item.dataset[DATASET_PLAYER_ID] === resolvedId &&
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
          renderTrend(item, trend, { weekKey: weekContext.cacheKey });
        } catch (error) {
          renderMessage(item, 'Sleeper+ trend unavailable', {
            weekKey: weekContext?.cacheKey || getCurrentWeekKey(),
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

    const parseWeekFromString = (value) => {
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
      const keywordMatch = normalized.match(/(?:week|wk|leg)[^0-9]{0,10}(\d{1,2})/i);
      if (keywordMatch) {
        const candidate = Number(keywordMatch[1]);
        if (withinWeekBounds(candidate)) {
          return candidate;
        }
      }
      const suffixMatch = normalized.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:week|wk|leg)/i);
      if (suffixMatch) {
        const candidate = Number(suffixMatch[1]);
        if (withinWeekBounds(candidate)) {
          return candidate;
        }
      }
      const digitsOnly = normalized.replace(/[^0-9]/g, '');
      if (digitsOnly && digitsOnly.length <= 2) {
        const candidate = Number(digitsOnly);
        if (withinWeekBounds(candidate)) {
          return candidate;
        }
      }
      return null;
    };

    const extractWeekFromElement = (element) => {
      if (!element) {
        return null;
      }
      const attributeCandidates = [
        element.getAttribute?.('data-week'),
        element.getAttribute?.('data-leg'),
        element.getAttribute?.('data-value'),
        element.getAttribute?.('data-option'),
        element.dataset?.week,
        element.dataset?.leg,
        element.dataset?.value,
        element.dataset?.option,
        element.id,
        element.getAttribute?.('data-testid'),
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.value,
      ];
      for (let index = 0; index < attributeCandidates.length; index += 1) {
        const parsed = parseWeekFromString(attributeCandidates[index]);
        if (withinWeekBounds(parsed)) {
          return parsed;
        }
      }
      const textContent = element.textContent?.trim();
      if (textContent) {
        const parsedText = parseWeekFromString(textContent);
        if (withinWeekBounds(parsedText)) {
          return parsedText;
        }
      }
      return null;
    };

    const detectDisplayedWeek = () => {
      for (let selectorIndex = 0; selectorIndex < WEEK_ACTIVE_SELECTORS.length; selectorIndex += 1) {
        const selector = WEEK_ACTIVE_SELECTORS[selectorIndex];
        if (!selector) {
          continue;
        }
        const nodes = document.querySelectorAll(selector);
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
          const week = extractWeekFromElement(nodes[nodeIndex]);
          if (withinWeekBounds(week)) {
            return week;
          }
        }
      }
      const fallbackNodes = Array.from(document.querySelectorAll(WEEK_FALLBACK_SELECTOR)).slice(0, 50);
      for (let index = 0; index < fallbackNodes.length; index += 1) {
        const week = extractWeekFromElement(fallbackNodes[index]);
        if (withinWeekBounds(week)) {
          return week;
        }
      }
      return null;
    };

    const pollDisplayedWeek = () => {
      if (!running) {
        return;
      }
      const detectedWeek = detectDisplayedWeek();
      if (!withinWeekBounds(detectedWeek) || detectedWeek === activeWeek) {
        return;
      }
      activeWeek = detectedWeek;
      cleanupAll();
      scheduleScan();
    };

    const handleWeekSelectorClick = (event) => {
      const target = event?.target instanceof Element ? event.target.closest(WEEK_CLICK_TARGET_SELECTOR) : null;
      if (!target) {
        return;
      }
      window.requestAnimationFrame(() => pollDisplayedWeek());
      window.setTimeout(() => pollDisplayedWeek(), 250);
    };

    const attachWeekClickListener = () => {
      if (weekClickListenerAttached) {
        return;
      }
      document.addEventListener('click', handleWeekSelectorClick, true);
      weekClickListenerAttached = true;
    };

    const detachWeekClickListener = () => {
      if (!weekClickListenerAttached) {
        return;
      }
      document.removeEventListener('click', handleWeekSelectorClick, true);
      weekClickListenerAttached = false;
    };

    const startWeekWatch = () => {
      if (weekPollIntervalId) {
        return;
      }
      pollDisplayedWeek();
      weekPollIntervalId = window.setInterval(() => pollDisplayedWeek(), WEEK_POLL_INTERVAL_MS);
      attachWeekClickListener();
    };

    const stopWeekWatch = () => {
      if (weekPollIntervalId) {
        window.clearInterval(weekPollIntervalId);
        weekPollIntervalId = null;
      }
      detachWeekClickListener();
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
        const shouldScan = mutations.some(shouldReactToMutation);
        if (shouldScan) {
          scheduleScan();
        }
      });
      rosterObserver.observe(target, { childList: true });
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
      inflightTrends.clear();
      pendingTrendRequests = 0;
      updateRefreshIndicator();
      if (!leagueId) {
        stop();
      } else if (running) {
        scheduleScan();
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

  const injectSettingsButton = () => {
    if (!shouldDisplaySettingsButton()) {
      return false;
    }

    if (document.getElementById(BUTTON_CONTAINER_ID)) {
      return true;
    }

    const target = document.querySelector('.settings-header-container');
    if (!target || !target.parentElement) {
      return false;
    }

    const parent = target.parentElement;

    const openOptions = () => {
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

    parent.classList.add(SETTINGS_PARENT_CLASS);

    const container = document.createElement('div');
    container.id = BUTTON_CONTAINER_ID;
    container.className = target.className;
    container.classList.add(ENTRY_CLASS);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = '+';
    button.title = 'Sleeper+ Settings';
    button.setAttribute('aria-label', 'Open Sleeper+ settings');

    const applyVisualStylesFrom = (element) => {
      if (!element) {
        return false;
      }

      const computed = window.getComputedStyle(element);
      if (!computed) {
        return false;
      }

      let applied = false;

      if (computed.borderRadius && parseFloat(computed.borderRadius)) {
        button.style.borderRadius = computed.borderRadius;
        container.style.borderRadius = computed.borderRadius;
        applied = true;
      }

      if (computed.padding) {
        button.style.padding = computed.padding;
        applied = true;
      }

      if (computed.minHeight && computed.minHeight !== '0px') {
        button.style.minHeight = computed.minHeight;
        applied = true;
      }

      if (computed.minWidth && computed.minWidth !== '0px') {
        button.style.minWidth = computed.minWidth;
        applied = true;
      }

      if (computed.color) {
        button.style.color = computed.color;
        applied = true;
      }

      return applied;
    };

    const referenceButton =
      (target.matches('button, [role="button"]') && target) ||
      target.querySelector('button, [role="button"]');
    if (referenceButton) {
      referenceButton.classList.forEach((className) => {
        if (!button.classList.contains(className)) {
          button.classList.add(className);
        }
      });
      const copiedFromReference = applyVisualStylesFrom(referenceButton);
      if (!copiedFromReference) {
        applyVisualStylesFrom(target);
      }
    } else {
      applyVisualStylesFrom(target);
    }

    button.addEventListener('click', (event) => {
      event.preventDefault();
      openOptions();
    });

    container.appendChild(button);
    parent.insertBefore(container, target);

    return true;
  };

  const removeSettingsButton = () => {
    const existing = document.getElementById(BUTTON_CONTAINER_ID);
    if (!existing) {
      return;
    }

    const parent = existing.parentElement;
    existing.remove();
    refreshIndicatorController.remove();

    if (parent && parent.classList.contains(SETTINGS_PARENT_CLASS)) {
      const remaining = parent.querySelector(`#${BUTTON_CONTAINER_ID}`);
      if (!remaining) {
        parent.classList.remove(SETTINGS_PARENT_CLASS);
      }
    }
  };

  const startSettingsObserver = () => {
    if (settingsObserver || !document.body) {
      return;
    }

    settingsObserver = new MutationObserver(() => {
      if (!shouldDisplaySettingsButton()) {
        return;
      }

      if (!document.getElementById(BUTTON_CONTAINER_ID)) {
        injectSettingsButton();
      }
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
    const shouldRunTrends = isActive && enableTrendOverlays && Boolean(activeLeagueId);
    trendOverlayManager.update({ enabled: shouldRunTrends, leagueId: shouldRunTrends ? activeLeagueId : '' });
    if (shouldRunTrends) {
      trendOverlayManager.refresh();
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

  const initialize = async () => {
    const stored = await getStoredSettings();
    leagueIds = stored.leagueIds;
    chatMaxWidth = stored.chatMaxWidth;
    showSettingsButton = stored.showSettingsButton;
    disableSleeperPlus = stored.disableSleeperPlus;
    enableTrendOverlays = stored.enableTrendOverlays;
    showOpponentRanks = stored.showOpponentRanks;

    evaluateActivation();
    currentBaseUrl = window.location.href;
    watchHistoryChanges();
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
