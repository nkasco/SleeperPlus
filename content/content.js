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
  const DEFAULT_SHOW_OPPONENT_RANKS = false;
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
      showOpponentRanks: false,
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
      /* ========================================
         SLEEPER+ DESIGN SYSTEM
         Modern, cohesive theme with glass-morphism
         ======================================== */
      
      :root {
        /* Color Palette */
        --sp-bg-deep: #0a0f1a;
        --sp-bg-primary: #0f1621;
        --sp-bg-secondary: #1a2332;
        --sp-bg-elevated: #232f42;
        --sp-bg-glass: rgba(26, 35, 50, 0.75);
        
        /* Accent Colors */
        --sp-accent-primary: #22d3ee;
        --sp-accent-secondary: #6366f1;
        --sp-accent-success: #10b981;
        --sp-accent-warning: #f59e0b;
        --sp-accent-danger: #ef4444;
        
        /* Text Colors */
        --sp-text-primary: #f8fafc;
        --sp-text-secondary: #cbd5e1;
        --sp-text-tertiary: #94a3b8;
        --sp-text-muted: #64748b;
        
        /* Border Colors */
        --sp-border-subtle: rgba(148, 163, 184, 0.1);
        --sp-border-medium: rgba(148, 163, 184, 0.2);
        --sp-border-strong: rgba(148, 163, 184, 0.35);
        --sp-border-accent: rgba(34, 211, 238, 0.3);
        
        /* Shadow System */
        --sp-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.2);
        --sp-shadow-md: 0 4px 16px rgba(0, 0, 0, 0.3);
        --sp-shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.4);
        --sp-shadow-xl: 0 16px 48px rgba(0, 0, 0, 0.5);
        
        /* Glass Effect */
        --sp-glass-bg: rgba(255, 255, 255, 0.05);
        --sp-glass-border: rgba(255, 255, 255, 0.1);
        --sp-glass-shine: rgba(255, 255, 255, 0.08);
        
        /* Spacing Scale */
        --sp-space-xs: 4px;
        --sp-space-sm: 8px;
        --sp-space-md: 12px;
        --sp-space-lg: 16px;
        --sp-space-xl: 24px;
        --sp-space-2xl: 32px;
        
        /* Border Radius */
        --sp-radius-sm: 8px;
        --sp-radius-md: 12px;
        --sp-radius-lg: 16px;
        --sp-radius-xl: 24px;
        --sp-radius-full: 9999px;
        
        /* Transitions */
        --sp-transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
        --sp-transition-base: 250ms cubic-bezier(0.4, 0, 0.2, 1);
        --sp-transition-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      
      .${SETTINGS_PARENT_CLASS} {
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: var(--sp-space-md) !important;
        flex-wrap: wrap;
      }
      
      /* Force the settings container to always layout its immediate
         children horizontally and prevent wrapping (covers header & actions). */
      #${BUTTON_CONTAINER_ID},
      #${BUTTON_CONTAINER_ID}[data-placement='header'],
      #${BUTTON_CONTAINER_ID}[data-placement='actions'] {
        display: inline-flex !important;
        flex-direction: row !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        justify-content: flex-start !important;
        padding: 0;
        gap: var(--sp-space-sm) !important;
        min-width: 72px;
      }

      /* Ensure the two wrapper groups (spark + main) are horizontal
         siblings inside the container while keeping their internal
         structure vertical (button above label). */
      #${BUTTON_CONTAINER_ID} > .sleeper-plus-main-button-group,
      #${BUTTON_CONTAINER_ID} > .sleeper-plus-spark-group {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 0 1 auto;
        min-width: 0;
        gap: 6px;
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
        display: inline-flex !important;
        flex-direction: row !important;
        align-items: center !important;
        gap: var(--sp-space-sm) !important;
      }

      /* When placed in the header, match the site header control size (40x40)
         so the injected button visually aligns with the native settings control. */
      #${BUTTON_CONTAINER_ID}[data-placement='header'] .sleeper-plus-settings-button-shell {
        width: 40px !important;
        height: 40px !important;
      }

      /* Ensure the main group wrapper does not force larger sizing in header */
      #${BUTTON_CONTAINER_ID}[data-placement='header'] > .sleeper-plus-main-button-group {
        gap: 4px;
        min-width: 0;
      }

      /* Hide the under-label when the container is placed in the header
         (non-team pages). This keeps the control compact and aligned with
         the native header control appearance. */
      #${BUTTON_CONTAINER_ID}[data-placement='header'] .sleeper-plus-settings-label {
        display: none !important;
      }
      
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        border-radius: var(--sp-radius-lg);
        border: 1px solid var(--sp-glass-border);
        background: linear-gradient(135deg, var(--sp-glass-bg) 0%, rgba(15, 22, 33, 0.85) 100%);
        backdrop-filter: blur(16px) saturate(160%);
        box-shadow: var(--sp-shadow-lg), inset 0 1px 2px var(--sp-glass-shine);
        padding: 0;
        transition: all var(--sp-transition-base);
        position: relative;
        overflow: hidden;
      }
      
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(circle at 50% 0%, var(--sp-accent-primary), transparent 70%);
        opacity: 0;
        transition: opacity var(--sp-transition-base);
      }
      
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:hover {
        border-color: var(--sp-accent-primary);
        box-shadow: 
          var(--sp-shadow-xl), 
          0 0 0 2px rgba(34, 211, 238, 0.2),
          inset 0 1px 2px var(--sp-glass-shine);
        transform: translateY(-1px);
      }

      /* Active/toggled state for inline action buttons (e.g. sparkline toggle) */
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell.toggle-active {
        border-color: var(--sp-accent-primary);
        box-shadow: var(--sp-shadow-lg), 0 0 0 4px rgba(34,211,238,0.06), inset 0 1px 2px var(--sp-glass-shine);
        transform: translateY(-1px) scale(1.02);
      }
      
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:hover::before,
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:focus-within::before {
        opacity: 0.2;
      }
      
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        border: none;
        background: transparent;
        color: var(--sp-text-primary);
        cursor: pointer;
        padding: 0;
        transition: all var(--sp-transition-fast);
        position: relative;
        z-index: 1;
      }
      
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:focus-visible {
        outline: 2px solid var(--sp-accent-primary);
        outline-offset: 2px;
        border-radius: var(--sp-radius-sm);
      }
      
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS} svg {
        width: 22px;
        height: 22px;
        filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));
        transition: transform var(--sp-transition-fast);
      }
      
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:hover .${BUTTON_CLASS} svg {
        transform: rotate(90deg) scale(1.15);
        filter: drop-shadow(0 2px 8px rgba(34, 211, 238, 0.6));
      }
      
      .sleeper-plus-settings-label {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        font-size: 0.625rem;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        font-weight: 700;
        color: var(--sp-text-secondary);
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      }
      
      .${REFRESH_INDICATOR_CLASS} {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--sp-text-secondary);
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        min-height: 20px;
        padding: var(--sp-space-xs) var(--sp-space-md);
        background: var(--sp-glass-bg);
        border-radius: var(--sp-radius-full);
        border: 1px solid var(--sp-glass-border);
        backdrop-filter: blur(8px);
      }
      
      #${BUTTON_CONTAINER_ID}[data-placement='actions'] .${REFRESH_INDICATOR_CLASS} {
        font-size: 0.7rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        justify-content: center;
      }
      
      .${REFRESH_INDICATOR_CLASS}.${REFRESH_INDICATOR_HIDDEN_CLASS} {
        display: none !important;
      }
      
      /* Modern Team Roster Cards */
      .team-roster-item {
        margin: var(--sp-space-sm) !important;
        padding: var(--sp-space-md) !important;
        border-radius: var(--sp-radius-md) !important;
        border: 1px solid var(--sp-border-subtle) !important;
        background-clip: padding-box;
        transition: all var(--sp-transition-base) !important;
        position: relative;
        overflow: hidden;
      }
      
      .team-roster-item::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, var(--sp-glass-shine), transparent 60%);
        opacity: 0;
        transition: opacity var(--sp-transition-base);
        pointer-events: none;
      }
      
      .team-roster-item:hover::before {
        opacity: 1;
      }
      
      /* Improve roster table column contrast */
      .team-roster-item .cell {
        color: var(--sp-text-secondary) !important;
      }
      
      .team-roster-item .player .full {
        color: var(--sp-text-primary) !important;
        font-weight: 600;
      }
      
      /* Enhance ownership percentage visibility */
      .team-roster-item .ownership-pct,
      .team-roster-item .start-pct,
      .team-roster-item [class*='pct'] {
        color: var(--sp-text-primary) !important;
        font-weight: 700;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
        font-size: 0.9rem;
      }
      
      /* Projected points styling */
      .team-roster-item .pts {
        color: var(--sp-accent-primary) !important;
        font-weight: 700;
        text-shadow: 0 0 8px rgba(34, 211, 238, 0.3);
      }
      
      .team-roster-item.odd {
        background: linear-gradient(135deg, rgba(26, 35, 50, 0.4) 0%, rgba(15, 22, 33, 0.3) 100%) !important;
        border-color: var(--sp-border-medium) !important;
      }
      
      .team-roster-item.even {
        background: linear-gradient(135deg, rgba(35, 47, 66, 0.3) 0%, rgba(26, 35, 50, 0.25) 100%) !important;
        border-color: var(--sp-border-subtle) !important;
      }
      
      .team-roster-item.out {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, rgba(185, 28, 28, 0.05) 100%) !important;
        border-color: var(--sp-accent-danger) !important;
        border-width: 1.5px !important;
      }
      
      /* Elegant Selected Player State */
      .team-roster-item.selected.valid {
        background: linear-gradient(135deg, 
          rgba(34, 211, 238, 0.15) 0%, 
          rgba(99, 102, 241, 0.12) 50%, 
          rgba(16, 185, 129, 0.1) 100%) !important;
        border: 2px solid var(--sp-accent-primary) !important;
        box-shadow: 
          0 0 0 1px rgba(34, 211, 238, 0.2),
          0 8px 24px rgba(34, 211, 238, 0.25),
          inset 0 1px 2px var(--sp-glass-shine) !important;
        color: inherit;
        transform: translateY(-2px);
      }
      
      .team-roster-item.selected.valid .link-button.cell-position {
        background: transparent !important;
        border-color: transparent !important;
        box-shadow: none !important;
      }
      
      .team-roster-item.selected.valid .league-slot-position-square {
        background: linear-gradient(135deg, 
          rgba(34, 211, 238, 0.2) 0%, 
          rgba(99, 102, 241, 0.18) 100%) !important;
        border-radius: var(--sp-radius-md) !important;
        border: 1px solid var(--sp-accent-primary) !important;
        box-shadow: 
          0 4px 12px rgba(34, 211, 238, 0.3),
          inset 0 1px 2px var(--sp-glass-shine) !important;
      }
      
      .team-roster-item.selected.valid .league-slot-position-square > div {
        color: var(--sp-text-primary) !important;
        letter-spacing: 0.05em;
        font-weight: 700;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      }
    `;

  const getNavbarStyleBlock = () => `
      /* ========================================
         MODERN NAVIGATION WITH GLASS-MORPHISM
         ======================================== */
      
      .center-tab-selector {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--sp-space-sm);
        padding: 6px;
        border-radius: var(--sp-radius-lg);
        background: var(--sp-glass-bg);
        backdrop-filter: blur(16px) saturate(180%);
        border: 1px solid var(--sp-glass-border);
        box-shadow: var(--sp-shadow-md);
        position: relative;
      }
      
      .center-tab-selector::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: linear-gradient(135deg, 
          rgba(34, 211, 238, 0.05) 0%, 
          rgba(99, 102, 241, 0.05) 50%,
          transparent 100%);
        pointer-events: none;
      }
      
      .center-tab-selector .item-tab {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: var(--sp-space-sm);
        padding: 10px 20px;
        border-radius: var(--sp-radius-full);
        cursor: pointer;
        color: var(--sp-text-secondary);
        background: transparent;
        border: 1px solid transparent;
        font-weight: 600;
        transition: all var(--sp-transition-base);
        z-index: 1;
      }
      
      .center-tab-selector .item-tab::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: var(--sp-glass-bg);
        opacity: 0;
        transition: opacity var(--sp-transition-base);
        z-index: -1;
      }
      
      .center-tab-selector .item-tab:hover:not(.selected) {
        color: var(--sp-text-primary);
        border-color: var(--sp-border-medium);
        transform: translateY(-1px);
      }
      
      .center-tab-selector .item-tab:hover:not(.selected)::before {
        opacity: 1;
      }
      
      .center-tab-selector .item-tab.selected {
        color: #0a0f1a;
        background: linear-gradient(135deg, 
          var(--sp-accent-primary) 0%, 
          rgba(99, 102, 241, 0.9) 100%);
        border-color: rgba(34, 211, 238, 0.3);
        box-shadow: 
          0 4px 16px rgba(34, 211, 238, 0.4),
          inset 0 1px 2px rgba(255, 255, 255, 0.3);
        font-weight: 700;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
        transform: translateY(-1px);
      }
      
      .center-tab-selector .item-tab.selected::before {
        opacity: 0;
      }
      
      .center-tab-selector .item-tab:focus-visible {
        outline: 2px solid var(--sp-accent-primary);
        outline-offset: 2px;
      }
      
      .center-tab-selector .item-tab svg {
        width: 14px;
        height: 14px;
        flex: 0 0 14px;
        color: inherit;
        opacity: 0.8;
        transition: all var(--sp-transition-fast);
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
      }
      
      .center-tab-selector .item-tab:hover svg,
      .center-tab-selector .item-tab.selected svg {
        opacity: 1;
        transform: scale(1.1);
      }
      
      .center-tab-selector .item-tab svg,
      .center-tab-selector .item-tab svg * {
        stroke: currentColor !important;
        fill: currentColor !important;
        color: currentColor !important;
        stroke-width: 1.5 !important;
      }
      
      .center-tab-selector .selector-title {
        font-size: 0.8rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 700;
        color: inherit;
      }
    `;

  const getTrendStyleBlock = () => `
      /* ========================================
         PLAYER TREND OVERLAYS & SPARKLINES
         ======================================== */
      
      .sleeper-plus-trend-row {
        display: flex;
        align-items: flex-start;
        flex-wrap: nowrap;
        gap: var(--sp-space-sm);
      }

      /* Ensure the left name column stacks into multiple rows
         while the trend panel stays to the right. */
      /* Left column container: name (single line), schedule (3-line clamp), stats (single line) */
      .sleeper-plus-trend-left {
        display: flex !important;
        flex-direction: column !important;
        gap: 4px !important;
        align-items: stretch !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
      }

      .sleeper-plus-trend-left .player-name-row {
        display: flex !important;
        align-items: center !important;
        gap: var(--sp-space-xs) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        width: 100% !important;
      }

      .sleeper-plus-trend-schedule {
        display: -webkit-box !important;
        -webkit-line-clamp: 3 !important;
        -webkit-box-orient: vertical !important;
        overflow: hidden !important;
        white-space: normal !important;
        width: auto !important;
      }

      .sleeper-plus-trend-middle {
        display: flex !important;
        flex-direction: row !important;
        gap: 4px !important;
        align-items: center !important;
        width: 100% !important;
      }

      .sleeper-plus-trend-middle .player-injury-container {
        flex: 0 0 auto !important;
        display: inline-flex !important;
        align-items: center !important;
      }

      .sleeper-plus-trend-left .player-stat-text {
        display: block !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        width: 100% !important;
      }
      
      .sleeper-plus-trend {
        margin-left: auto;
        display: inline-flex;
        flex-direction: column;
        align-items: stretch;
        gap: var(--sp-space-md);
        font-size: 0.85rem;
        line-height: 1.4;
        color: inherit;
        min-width: 320px;
        max-width: 100%;
        padding: var(--sp-space-md);
        background: var(--sp-glass-bg);
        backdrop-filter: blur(8px);
        border-radius: var(--sp-radius-md);
        border: 1px solid var(--sp-border-subtle);
        transition: all var(--sp-transition-base);
      }
      
      .sleeper-plus-trend:hover {
        border-color: var(--sp-border-medium);
        box-shadow: var(--sp-shadow-sm);
      }
      
      .sleeper-plus-trend__stack {
        display: flex;
        flex-direction: column;
        gap: var(--sp-space-sm);
        padding-left: var(--sp-space-md);
        padding-right: var(--sp-space-md);
        border-left: 2px solid var(--sp-accent-primary);
        white-space: normal;
      }
      
      .sleeper-plus-trend__meta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--sp-space-md);
      }
      
      .sleeper-plus-trend__meta-item {
        display: flex;
        gap: var(--sp-space-xs);
        align-items: baseline;
        padding: 4px 8px;
        background: var(--sp-glass-bg);
        border-radius: var(--sp-radius-sm);
        border: 1px solid var(--sp-border-subtle);
      }
      
      .sleeper-plus-trend__meta-label {
        color: var(--sp-text-tertiary);
        text-transform: uppercase;
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        font-weight: 600;
      }
      
      .sleeper-plus-trend__chart {
        flex: 0 0 auto;
        min-height: 48px;
        text-align: right;
        width: 100%;
        padding: var(--sp-space-sm);
        background: rgba(0, 0, 0, 0.2);
        border-radius: var(--sp-radius-sm);
        border: 1px solid var(--sp-border-subtle);
      }
      
      .sleeper-plus-trend__chart > svg {
        flex: 0 0 16px;
        width: 100%;
        height: 52px;
      }
      
      .sleeper-plus-trend__chart svg {
        background: transparent;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
      }
      
      .sleeper-plus-trend__chart svg polygon {
        fill: rgba(34, 211, 238, 0.08) !important;
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-line {
        fill: none;
        stroke-width: 2.5;
        stroke-linejoin: round;
        stroke-linecap: round;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-line.line-over {
        stroke: var(--sp-accent-success);
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-line.line-under {
        stroke: var(--sp-accent-danger);
      }
      
      .sleeper-plus-user-tab-row {
        align-items: stretch;
        flex-wrap: wrap;
        gap: var(--sp-space-lg);
      }
      /* ========================================
         ELEGANT TEAM TOTALS CARD
         ======================================== */
      
      .sleeper-plus-team-totals {
        flex: 0 0 auto;
        width: 720px;
        max-width: 100%;
        margin: var(--sp-space-md) auto;
        padding: var(--sp-space-xl);
        border-radius: var(--sp-radius-xl);
        border: 1px solid var(--sp-glass-border);
        background: var(--sp-glass-bg);
        backdrop-filter: blur(24px) saturate(180%);
        box-shadow: var(--sp-shadow-xl);
        display: flex;
        flex-direction: column;
        gap: var(--sp-space-lg);
        min-width: 0;
        max-width: none;
        font-size: 0.8rem;
        align-self: center;
        position: relative;
        overflow: hidden;
        box-sizing: border-box;
        transition: all var(--sp-transition-base);
      }
      
      .sleeper-plus-team-totals::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, 
          rgba(34, 211, 238, 0.08) 0%, 
          rgba(99, 102, 241, 0.06) 50%,
          rgba(16, 185, 129, 0.05) 100%);
        pointer-events: none;
        border-radius: inherit;
      }
      
      .sleeper-plus-team-totals:hover {
        border-color: var(--sp-border-accent);
        box-shadow: 
          var(--sp-shadow-xl),
          0 0 0 1px var(--sp-border-accent);
      }
      .sleeper-plus-team-totals__shell {
        display: flex;
        flex-direction: column;
        gap: 0;
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
        flex: 0 0 52px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        overflow: hidden;
        box-shadow: var(--sp-shadow-md);
        border: 2px solid var(--sp-glass-border);
        background-clip: padding-box;
        transition: all var(--sp-transition-base);
      }
      
      .sleeper-plus-team-totals__identity-row .avatar:hover {
        border-color: var(--sp-accent-primary);
        box-shadow: var(--sp-shadow-lg), 0 0 0 2px rgba(34, 211, 238, 0.2);
      }
      
      .sleeper-plus-team-totals__identity-row .info {
        flex: 1 1 auto;
        min-width: 0;
      }
      
      .sleeper-plus-team-totals__identity-row .name-row {
        font-size: 1.25rem;
        font-weight: 800;
        gap: var(--sp-space-sm);
        color: var(--sp-text-primary);
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
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
        position: relative;
        z-index: 1;
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
        font-size: 1.125rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        opacity: 0.95;
        color: var(--sp-text-primary);
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
      }
      .sleeper-plus-team-totals__week {
        font-weight: 700;
        font-size: 0.9rem;
        letter-spacing: 0.16em;
        color: var(--sp-accent-primary);
        text-shadow: 0 0 12px rgba(34, 211, 238, 0.4);
        padding: 2px 0;
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
        position: relative;
        z-index: 2;
        margin-top: -18px;
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
        min-width: 130px;
        gap: 6px;
        font-variant-numeric: tabular-nums;
        text-align: right;
        padding: 8px 0;
      }
      .sleeper-plus-team-totals__label {
        color: var(--sp-text-secondary);
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.16em;
        text-align: right;
        font-weight: 700;
        opacity: 0.9;
      }
      
      .sleeper-plus-team-totals__value {
        font-weight: 800;
        font-size: 2.25rem;
        line-height: 1;
        text-align: right;
        text-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
        transition: all var(--sp-transition-fast);
        margin-top: 2px;
      }
      
      .sleeper-plus-team-totals__row[data-variant='actual'] .sleeper-plus-team-totals__value {
        color: var(--sp-accent-success);
        text-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
      }
      
      .sleeper-plus-team-totals__row[data-variant='projected'] .sleeper-plus-team-totals__value {
        color: var(--sp-accent-primary);
        text-shadow: 0 0 12px rgba(34, 211, 238, 0.4);
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
        width: 52px;
        height: 52px;
        border-radius: var(--sp-radius-full);
        border: 1px solid var(--sp-glass-border);
        background: var(--sp-glass-bg);
        backdrop-filter: blur(8px);
        box-shadow: var(--sp-shadow-md), inset 0 1px 2px var(--sp-glass-shine);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: all var(--sp-transition-base);
        position: relative;
        overflow: hidden;
      }
      
      .sleeper-plus-team-totals__actions-row button::before,
      .sleeper-plus-team-totals__actions-row .button::before,
      .sleeper-plus-team-totals__actions-row .btn::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(circle at 50% 0%, var(--sp-accent-primary), transparent 70%);
        opacity: 0;
        transition: opacity var(--sp-transition-base);
      }
      
      .sleeper-plus-team-totals__actions-row button svg,
      .sleeper-plus-team-totals__actions-row .button svg,
      .sleeper-plus-team-totals__actions-row .btn svg {
        width: 22px;
        height: 22px;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
        transition: transform var(--sp-transition-fast);
        position: relative;
        z-index: 1;
      }
      
      .sleeper-plus-team-totals__actions-row button:hover,
      .sleeper-plus-team-totals__actions-row .button:hover,
      .sleeper-plus-team-totals__actions-row .btn:hover,
      .sleeper-plus-team-totals__actions-row button:focus-visible,
      .sleeper-plus-team-totals__actions-row .button:focus-visible,
      .sleeper-plus-team-totals__actions-row .btn:focus-visible {
        border-color: var(--sp-accent-primary);
        box-shadow: var(--sp-shadow-lg), inset 0 1px 2px var(--sp-glass-shine);
        transform: translateY(-2px);
      }
      
      .sleeper-plus-team-totals__actions-row button:hover::before,
      .sleeper-plus-team-totals__actions-row .button:hover::before,
      .sleeper-plus-team-totals__actions-row .btn:hover::before {
        opacity: 0.15;
      }
      
      .sleeper-plus-team-totals__actions-row button:hover svg,
      .sleeper-plus-team-totals__actions-row .button:hover svg,
      .sleeper-plus-team-totals__actions-row .btn:hover svg {
        transform: scale(1.1);
      }
      
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:hover,
      #${BUTTON_CONTAINER_ID} .sleeper-plus-settings-button-shell:focus-within {
        border-color: var(--sp-accent-primary);
        box-shadow: var(--sp-shadow-lg), inset 0 1px 2px var(--sp-glass-shine);
        transform: translateY(-2px) scale(1.05);
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
        stroke: var(--sp-accent-secondary);
        stroke-width: 2.5;
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-line.line-future {
        stroke: var(--sp-text-tertiary);
        stroke-width: 2.5;
        stroke-dasharray: 6 4;
        opacity: 0.5;
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-projection-line {
        stroke: var(--sp-accent-primary);
        stroke-width: 2.5;
        stroke-dasharray: 6 4;
        fill: none;
        filter: drop-shadow(0 1px 4px rgba(34, 211, 238, 0.5));
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-dot {
        stroke: var(--sp-bg-deep);
        stroke-width: 2;
        transition: all var(--sp-transition-fast);
        cursor: pointer;
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-dot:hover {
        r: 5;
        stroke-width: 2.5;
        filter: brightness(1.2);
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-dot.over {
        fill: var(--sp-accent-success);
        filter: drop-shadow(0 2px 4px rgba(16, 185, 129, 0.7));
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-dot.under {
        fill: var(--sp-accent-danger);
        filter: drop-shadow(0 2px 4px rgba(239, 68, 68, 0.7));
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-dot.neutral {
        fill: var(--sp-accent-secondary);
        filter: drop-shadow(0 2px 4px rgba(99, 102, 241, 0.7));
      }
      
      .sleeper-plus-trend__chart .sleeper-plus-dot.future {
        fill: var(--sp-text-tertiary);
        stroke: var(--sp-bg-secondary);
        opacity: 0.4;
      }
      /* ========================================
         MATCHUP QUALITY INDICATORS
         ======================================== */
      
      .sleeper-plus-matchup {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--sp-space-xs);
        padding: var(--sp-space-sm) var(--sp-space-md);
        border-radius: var(--sp-radius-sm);
        background: var(--sp-glass-bg);
        backdrop-filter: blur(8px);
        border: 1px solid var(--sp-border-accent);
        min-width: 140px;
        transition: all var(--sp-transition-base);
        box-shadow: var(--sp-shadow-sm);
      }
      
      .sleeper-plus-matchup:hover {
        transform: translateY(-1px);
        box-shadow: var(--sp-shadow-md);
      }
      
      .sleeper-plus-matchup__label {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--sp-text-tertiary);
        font-weight: 700;
      }
      
      .sleeper-plus-matchup__value {
        font-weight: 700;
        font-size: 0.95rem;
        color: var(--sp-text-primary);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      }
      
      .sleeper-plus-matchup.matchup-good {
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(5, 150, 105, 0.1) 100%);
        border-color: var(--sp-accent-success);
        box-shadow: var(--sp-shadow-sm), 0 0 0 1px rgba(16, 185, 129, 0.2);
      }
      
      .sleeper-plus-matchup.matchup-neutral {
        background: linear-gradient(135deg, rgba(34, 211, 238, 0.12) 0%, rgba(6, 182, 212, 0.08) 100%);
        border-color: var(--sp-accent-primary);
        box-shadow: var(--sp-shadow-sm), 0 0 0 1px rgba(34, 211, 238, 0.2);
      }
      
      .sleeper-plus-matchup.matchup-bad {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(220, 38, 38, 0.1) 100%);
        border-color: var(--sp-accent-danger);
        box-shadow: var(--sp-shadow-sm), 0 0 0 1px rgba(239, 68, 68, 0.2);
      }
      /* Inline Matchup Badges */
      .sleeper-plus-matchup-inline {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-space-xs);
        margin-left: var(--sp-space-sm);
        padding: 4px 12px;
        border-radius: var(--sp-radius-full);
        border: 1px solid var(--sp-border-accent);
        background: var(--sp-glass-bg);
        backdrop-filter: blur(8px);
        font-size: 0.75rem;
        line-height: 1.3;
        white-space: nowrap;
        transition: all var(--sp-transition-base);
        box-shadow: var(--sp-shadow-sm);
      }
      
      .sleeper-plus-matchup-inline:hover {
        transform: translateY(-1px);
        box-shadow: var(--sp-shadow-md);
      }
      
      .sleeper-plus-matchup-inline .sleeper-plus-matchup__label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--sp-text-tertiary);
        font-weight: 700;
      }
      
      .sleeper-plus-matchup-inline .sleeper-plus-matchup__value {
        font-size: 0.85rem;
        font-weight: 700;
        color: var(--sp-text-primary);
      }
      
      .sleeper-plus-matchup-inline.matchup-good {
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(5, 150, 105, 0.1) 100%);
        border-color: var(--sp-accent-success);
        box-shadow: var(--sp-shadow-sm), 0 0 0 1px rgba(16, 185, 129, 0.2);
      }
      
      .sleeper-plus-matchup-inline.matchup-neutral {
        background: linear-gradient(135deg, rgba(34, 211, 238, 0.12) 0%, rgba(6, 182, 212, 0.08) 100%);
        border-color: var(--sp-accent-primary);
        box-shadow: var(--sp-shadow-sm), 0 0 0 1px rgba(34, 211, 238, 0.2);
      }
      
      .sleeper-plus-matchup-inline.matchup-bad {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(220, 38, 38, 0.1) 100%);
        border-color: var(--sp-accent-danger);
        box-shadow: var(--sp-shadow-sm), 0 0 0 1px rgba(239, 68, 68, 0.2);
      }
      
      .sleeper-plus-matchup-inline.placeholder {
        background: var(--sp-glass-bg);
        border-color: var(--sp-border-medium);
        color: var(--sp-text-tertiary);
      }
      
      .sleeper-plus-matchup-inline.placeholder .sleeper-plus-matchup__label {
        color: var(--sp-text-muted);
      }
      
      .sleeper-plus-matchup-inline.placeholder .sleeper-plus-matchup__value {
        color: var(--sp-text-tertiary);
      }
      
      .sleeper-plus-trend__error {
        font-size: 0.8rem;
        color: var(--sp-accent-danger);
        padding: var(--sp-space-sm);
        background: rgba(239, 68, 68, 0.1);
        border-radius: var(--sp-radius-sm);
        border: 1px solid rgba(239, 68, 68, 0.3);
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

    // Arrange a left column inside the trend row so that the visual order
    // becomes: (1) player-name-row (single-line), (2) game-schedule-live-description
    // (clamped to 3 lines), (3) player-stat-text (single-line)
    const moveNameAndStatsIntoTrendRow = (item, trendRowHost) => {
      if (!item || !trendRowHost) return;
      const nameRow = item.querySelector('.player-name-row');
      const statText = item.querySelector('.player-stat-text');
      const scheduleDesc = item.querySelector('.game-schedule-live-description') || null;
      if (!scheduleDesc) return;

      // Ensure there's a left column container inside the trend row
      let leftCol = trendRowHost.querySelector('.sleeper-plus-trend-left');
      if (!leftCol) {
        leftCol = document.createElement('div');
        leftCol.className = 'sleeper-plus-trend-left';
        // Insert at start so the trend panel stays to the right
        if (trendRowHost.firstChild) {
          trendRowHost.insertBefore(leftCol, trendRowHost.firstChild);
        } else {
          trendRowHost.appendChild(leftCol);
        }
      }

      try {
        // locate optional nodes
        const rosterNickname = item.querySelector('.roster-nickname');
        const injuryContainer = item.querySelector('.player-injury-container');

        // Top: roster-nickname
        if (rosterNickname && rosterNickname.parentElement !== leftCol) {
          leftCol.appendChild(rosterNickname);
        }

        // Next: player-name-row (should be directly under nickname)
        if (nameRow && nameRow.parentElement !== leftCol) {
          leftCol.appendChild(nameRow);
        }

        // Middle: schedule + injury on same row (after name)
        let middleRow = leftCol.querySelector('.sleeper-plus-trend-middle');
        if (!middleRow) {
          middleRow = document.createElement('div');
          middleRow.className = 'sleeper-plus-trend-middle';
          // insert middle row after nameRow if present, else append
          if (nameRow && nameRow.nextSibling) {
            leftCol.insertBefore(middleRow, nameRow.nextSibling);
          } else {
            leftCol.appendChild(middleRow);
          }
        }

        // Ensure schedule container exists inside middleRow
        let scheduleContainer = middleRow.querySelector('.sleeper-plus-trend-schedule');
        if (!scheduleContainer) {
          scheduleContainer = document.createElement('div');
          scheduleContainer.className = 'sleeper-plus-trend-schedule';
          middleRow.appendChild(scheduleContainer);
        }

        if (scheduleDesc.parentElement !== scheduleContainer) {
          scheduleContainer.appendChild(scheduleDesc);
        }

        // Place injury container inline after schedule
        if (injuryContainer && injuryContainer.parentElement !== middleRow) {
          middleRow.appendChild(injuryContainer);
        }

        // Bottom: statText
        if (statText && statText.parentElement !== leftCol) {
          leftCol.appendChild(statText);
        }
      } catch (e) {
        // best-effort; ignore silently
      }
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
        moveNameAndStatsIntoTrendRow(item, trendRowHost);
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
        moveNameAndStatsIntoTrendRow(item, trendRowHost);
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
      const nodeList = roster.querySelectorAll('.team-roster-item');
      const items = Array.from(nodeList || []);
      if (items.length === 0) {
        cleanupAll();
        return;
      }

      // Batch processing: resolve IDs and fetch trend data for all items first,
      // then update the DOM in a single pass to avoid incremental per-player updates.
      const tasks = items.map((item) => {
        if (!item || !item.isConnected) {
          return Promise.resolve({ item, skip: true });
        }

        // If an item is already being processed, skip it so we don't duplicate work.
        if (processingMap.has(item)) {
          return Promise.resolve({ item, skip: true });
        }

        const task = (async () => {
          let weekContext = null;
          try {
            const identity = extractIdentity(item);
            if (!identity.playerId && !identity.fullName) {
              return { item, action: 'remove' };
            }

            const overlayRoster = isOverlayRoster(item);
            const allowOpponentDetails = showOpponentRanks && !overlayRoster;
            if (allowOpponentDetails) {
              ensureInlinePlaceholder(item);
            }

            const resolvedId = await resolvePlayerId(identity);
            if (!resolvedId) {
              return { item, error: true, weekKey: getCurrentWeekKey(), overlayRoster };
            }

            item.dataset[DATASET_PLAYER_ID] = resolvedId;
            weekContext = { weekNumber: getCurrentWeekNumber(), cacheKey: getCurrentWeekKey() };
            const trend = await fetchTrendData(resolvedId, weekContext);
            return { item, trend, weekKey: weekContext.cacheKey, overlayRoster };
          } catch (error) {
            return { item, error: true, weekKey: weekContext?.cacheKey || getCurrentWeekKey(), overlayRoster: isOverlayRoster(item) };
          }
        })();

        // Mark as processing to avoid duplicates
        processingMap.set(item, task.finally(() => processingMap.delete(item)));
        return task;
      });

      Promise.all(tasks).then((results) => {
        // Render the results in a single animation frame for smoother updates
        requestAnimationFrame(() => {
          results.forEach((result) => {
            if (!result || result.skip) return;
            const { item } = result;
            if (result.action === 'remove') {
              removeTrend(item);
              return;
            }
            if (result.error) {
              renderMessage(item, 'Sleeper+ trend unavailable', {
                weekKey: result.weekKey || getCurrentWeekKey(),
                overlayRoster: result.overlayRoster,
              });
              return;
            }

            // If the week context changed while fetching, schedule another scan
            if (result.weekKey && result.weekKey !== getCurrentWeekKey()) {
              scheduleScan();
              return;
            }

            renderTrend(item, result.trend, { weekKey: result.weekKey, overlayRoster: result.overlayRoster });
          });
        });
      });
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
    // Prevent layout shifts by reserving a conservative size and
    // rendering hidden until we apply any site-specific sizing.
    container.style.minWidth = '48px';
    container.style.minHeight = '48px';
    container.style.boxSizing = 'border-box';
    container.style.opacity = '0';
    container.style.transition = 'opacity var(--sp-transition-fast, 160ms) ease';

    const innerButton = document.createElement('button');
    innerButton.type = 'button';
    innerButton.className = BUTTON_CLASS;
    innerButton.title = 'Sleeper+ Settings';
    innerButton.setAttribute('aria-label', 'Open Sleeper+ settings');
    innerButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"
        fill="currentColor"
      />
      </svg>`;

    innerButton.addEventListener('click', (event) => {
      event.preventDefault();
      openSleeperPlusSettings();
    });

    // Apply shell class to the inner button (keeps original styling intent)
    innerButton.className = `${BUTTON_CLASS} sleeper-plus-settings-button-shell`;

    const innerLabel = document.createElement('div');
    innerLabel.className = 'btn-text sleeper-plus-settings-label';
    innerLabel.textContent = 'Sleeper+';

    // New wrapper div that nests the main button and its label
    const mainGroup = document.createElement('div');
    mainGroup.className = 'sleeper-plus-main-button-group';
    mainGroup.appendChild(innerButton);
    mainGroup.appendChild(innerLabel);

    // Expose variables the rest of the function expects:
    // - `button` should refer to the node appended into the container (use the wrapper)
    // - `label` is set to an empty fragment so subsequent container.appendChild(label) is a no-op
    const button = mainGroup;
    const label = document.createDocumentFragment();

    // Always append the main group here; spark group is managed dynamically
    container.appendChild(mainGroup);
    // Keep the container visually hidden until sizing/copying completes
    // to avoid visible resizing on hard refresh. It will be revealed by
    // `injectSettingsButton` after any computed styles are copied.
    return container;
  };

  // Helper: create and return the sparkline group (with handlers)
  const createSparkGroup = (container) => {
    const existing = container && container.querySelector && container.querySelector('.sleeper-plus-spark-group');
    if (existing) return existing;

    const sparkButton = document.createElement('button');
    sparkButton.type = 'button';
    sparkButton.className = `${BUTTON_CLASS} sleeper-plus-settings-button-shell`;
    sparkButton.title = 'Toggle player sparklines';
    sparkButton.setAttribute('aria-label', 'Toggle player sparklines');
    sparkButton.setAttribute('aria-pressed', 'false');
    sparkButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 17h3l3-6 4 8 4-12 4 6h3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" />
      </svg>`;

    const sparkLabel = document.createElement('div');
    sparkLabel.className = 'btn-text sleeper-plus-settings-label';
    sparkLabel.textContent = 'Sparkline';

    const sparkGroup = document.createElement('div');
    sparkGroup.className = 'sleeper-plus-spark-group';
    sparkGroup.appendChild(sparkButton);
    sparkGroup.appendChild(sparkLabel);

    try {
      chrome.storage.sync.get(['enableTrendOverlays'], (res) => {
        const enabled = res && typeof res.enableTrendOverlays === 'boolean' ? res.enableTrendOverlays : DEFAULT_ENABLE_TREND_OVERLAYS;
        if (enabled) {
          sparkButton.classList.add('toggle-active');
          sparkButton.setAttribute('aria-pressed', 'true');
        } else {
          sparkButton.classList.remove('toggle-active');
          sparkButton.setAttribute('aria-pressed', 'false');
        }
      });
    } catch (_) {}

    sparkButton.addEventListener('click', (event) => {
      event.preventDefault();
      const toggleLocal = (current) => {
        const next = !current;
        try {
          chrome.storage.sync.set({ enableTrendOverlays: next }, () => {
            try { enableTrendOverlays = !!next; } catch (_) {}
            if (next) { sparkButton.classList.add('toggle-active'); sparkButton.setAttribute('aria-pressed', 'true'); }
            else { sparkButton.classList.remove('toggle-active'); sparkButton.setAttribute('aria-pressed', 'false'); }
            try { if (typeof trendOverlayManager !== 'undefined' && trendOverlayManager && typeof trendOverlayManager.refresh === 'function') trendOverlayManager.refresh(); } catch (_) {}
          });
        } catch (e) {
          try { enableTrendOverlays = !!next; } catch (_) {}
          if (next) { sparkButton.classList.add('toggle-active'); sparkButton.setAttribute('aria-pressed', 'true'); }
          else { sparkButton.classList.remove('toggle-active'); sparkButton.setAttribute('aria-pressed', 'false'); }
          try { if (typeof trendOverlayManager !== 'undefined' && trendOverlayManager && typeof trendOverlayManager.refresh === 'function') trendOverlayManager.refresh(); } catch (_) {}
        }
      };

      if (typeof enableTrendOverlays === 'boolean') toggleLocal(enableTrendOverlays);
      else {
        try { chrome.storage.sync.get(['enableTrendOverlays'], (res) => { const current = res && typeof res.enableTrendOverlays === 'boolean' ? res.enableTrendOverlays : DEFAULT_ENABLE_TREND_OVERLAYS; toggleLocal(current); }); }
        catch (_) { toggleLocal(DEFAULT_ENABLE_TREND_OVERLAYS); }
      }
    });

    return sparkGroup;
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

    // Ensure sparkline group exists only on team pages. Add or remove it
    // dynamically so SPA navigation (client-side route changes) shows/hides
    // the sparkline button correctly.
    try {
      const hasSpark = container.querySelector('.sleeper-plus-spark-group');
      if (isTeamView()) {
        if (!hasSpark) {
          const spark = createSparkGroup(container);
          // insert spark group before the main group when present
          const main = container.querySelector('.sleeper-plus-main-button-group');
          if (main) container.insertBefore(spark, main);
          else container.insertBefore(spark, container.firstChild);
        }
      } else if (hasSpark) {
        try { hasSpark.remove(); } catch (_) {}
      }
    } catch (_) {}

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
          // Apply reference classes/styles to all injected button wrappers
          const wrappers = Array.from(container.querySelectorAll('.sleeper-plus-settings-button-shell'));
          // Copy class list from the reference button so site CSS applies automatically.
          try {
            const classListToCopy = Array.from(found.classList || []);
            wrappers.forEach((w) => {
              classListToCopy.forEach((c) => {
                if (!c) return;
                w.classList.add(c);
              });
            });
          } catch (_) {}

          // Copy a few key computed styles to ensure exact sizing when site
          // uses inline or computed values rather than only classes.
          const cs = window.getComputedStyle(found);
          wrappers.forEach((w) => {
            try {
              // Only copy explicit numeric sizes to avoid applying
              // '0px' or 'auto' values that cause layout jumps on hard
              // refresh. Fall back to the extension's CSS otherwise.
              const numericWidth = parseFloat(cs.width || '0');
              const numericHeight = parseFloat(cs.height || '0');
              if (Number.isFinite(numericWidth) && numericWidth > 0) {
                w.style.width = cs.width;
              }
              if (Number.isFinite(numericHeight) && numericHeight > 0) {
                w.style.height = cs.height;
              }
              w.style.borderRadius = cs.borderRadius || w.style.borderRadius;
              w.style.border = cs.border || w.style.border;
              w.style.background = cs.background || w.style.background;
              w.style.boxShadow = cs.boxShadow || w.style.boxShadow;
              w.style.transition = cs.transition || w.style.transition;
              w.style.padding = cs.padding || w.style.padding;
            } catch (_) {}
          });

          // Also apply visual classes and key computed styles to the inner buttons
          try {
            const inners = Array.from(container.querySelectorAll(`.${BUTTON_CLASS}`));
            inners.forEach((btn) => {
              try {
                classListToCopy.forEach((c) => {
                  if (!c) return;
                  btn.classList.add(c);
                });
                // copy transition so :hover transforms animate
                btn.style.transition = cs.transition || btn.style.transition;
              } catch (_) {}
            });
          } catch (_) {}

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
            // Keep actions container horizontal so spark/main groups sit side-by-side
            container.style.flexDirection = 'row';
            container.style.flexWrap = 'nowrap';
            container.style.gap = '9px';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'center';
            container.style.alignSelf = 'center';
            // also ensure each wrapper aligns and doesn't add extra spacing
            const wrappersAfter = Array.from(container.querySelectorAll('.sleeper-plus-settings-button-shell'));
            wrappersAfter.forEach((w) => {
              try {
                w.style.margin = '0';
                w.style.boxSizing = 'border-box';
              } catch (_) {}
            });
          } catch (_) {}

          // Copy SVG sizing if present on the reference button
          const refSvg = found.querySelector('svg');
          if (refSvg) {
            const rcs = window.getComputedStyle(refSvg);
            const ourSvgs = Array.from(container.querySelectorAll('.sleeper-plus-settings-button-shell svg'));
            ourSvgs.forEach((ourSvg) => {
              try {
                ourSvg.style.width = refSvg.getAttribute('width') || rcs.width || refSvg.style.width || '20px';
                ourSvg.style.height = refSvg.getAttribute('height') || rcs.height || refSvg.style.height || '20px';
              } catch (_) {}
            });
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

    // Reveal the container now that initial sizing/copying has completed
    try {
      // Small timeout allows the browser to settle any layout changes
      // before we fade in, avoiding visible flicker on hard refresh.
      setTimeout(() => {
        try { container.style.opacity = '1'; } catch (_) {}
      }, 35);
    } catch (_) {
      try { container.style.opacity = '1'; } catch (_) {}
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
