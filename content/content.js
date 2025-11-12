(() => {
  const STYLE_ELEMENT_ID = 'sleeper-plus-layout-style';
  const BUTTON_CONTAINER_ID = 'sleeper-plus-settings-container';
  const SETTINGS_PARENT_CLASS = 'sleeper-plus-settings-parent';
  const BUTTON_CLASS = 'sleeper-plus-settings-button';
  const ENTRY_CLASS = 'sleeper-plus-settings-entry';
  const SETTINGS_OBSERVER_CONFIG = { childList: true, subtree: true };

  const DEFAULT_CHAT_MAX_WIDTH = 400;
  const DEFAULT_SHOW_SETTINGS_BUTTON = true;
  const MIN_CHAT_MAX_WIDTH = 200;
  const MAX_CHAT_MAX_WIDTH = 800;

  const DEFAULT_SETTINGS = {
    leagueIds: [],
    chatMaxWidth: DEFAULT_CHAT_MAX_WIDTH,
    showSettingsButton: DEFAULT_SHOW_SETTINGS_BUTTON,
  };

  let leagueIds = [];
  let chatMaxWidth = DEFAULT_CHAT_MAX_WIDTH;
  let showSettingsButton = DEFAULT_SHOW_SETTINGS_BUTTON;
  let isActive = false;
  let settingsObserver = null;
  let currentBaseUrl = '';

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
    };
  };

  const getStoredSettings = () => {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        ['leagueIds', 'leagueId', 'chatMaxWidth', 'showSettingsButton'],
        (result) => resolve(sanitizeSettings(result))
      );
    });
  };

  const doesUrlMatchLeague = () => {
    if (leagueIds.length === 0) {
      return false;
    }

    const href = window.location.href;
    return leagueIds.some((id) => href.startsWith(`https://sleeper.com/leagues/${id}`));
  };

  const updateLayoutStyles = () => {
    const widthPx = `${chatMaxWidth}px`;
    let style = document.getElementById(STYLE_ELEMENT_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ELEMENT_ID;
      document.head.appendChild(style);
    }

    style.textContent = `
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
        padding: 6px;
        border-radius: 12px;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: inherit;
        font: inherit;
        font-size: 1.4rem;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        transition: background 0.15s ease-in-out, transform 0.15s ease-in-out;
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:hover,
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:focus-visible {
        background: rgba(255, 255, 255, 0.2);
        outline: none;
        transform: translateY(-1px);
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:focus-visible {
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.4);
      }
      #${BUTTON_CONTAINER_ID} .${BUTTON_CLASS}:active {
        transform: translateY(0);
      }
    `;
  };

  const removeStyles = () => {
    const existing = document.getElementById(STYLE_ELEMENT_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  };

  const injectSettingsButton = () => {
    if (!showSettingsButton) {
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

    if (parent && parent.classList.contains(SETTINGS_PARENT_CLASS)) {
      const remaining = parent.querySelector(`#${BUTTON_CONTAINER_ID}`);
      if (!remaining) {
        parent.classList.remove(SETTINGS_PARENT_CLASS);
      }
    }
  };

  const startSettingsObserver = () => {
    if (settingsObserver || !document.body || !showSettingsButton) {
      return;
    }

    settingsObserver = new MutationObserver(() => {
      if (injectSettingsButton()) {
        stopSettingsObserver();
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

  const activateExtension = () => {
    isActive = true;
    updateLayoutStyles();

    if (showSettingsButton) {
      if (!injectSettingsButton()) {
        startSettingsObserver();
      }
    } else {
      removeSettingsButton();
      stopSettingsObserver();
    }
  };

  const deactivateExtension = () => {
    if (!isActive) {
      return;
    }

    isActive = false;
    removeStyles();
    removeSettingsButton();
    stopSettingsObserver();
  };

  const evaluateActivation = () => {
    if (leagueIds.length === 0) {
      deactivateExtension();
      return;
    }

    if (doesUrlMatchLeague()) {
      activateExtension();
    } else {
      deactivateExtension();
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
      showSettingsButton =
        typeof changes.showSettingsButton.newValue === 'boolean'
          ? changes.showSettingsButton.newValue
          : DEFAULT_SHOW_SETTINGS_BUTTON;

      if (isActive) {
        if (showSettingsButton) {
          if (!injectSettingsButton()) {
            startSettingsObserver();
          }
        } else {
          removeSettingsButton();
          stopSettingsObserver();
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
