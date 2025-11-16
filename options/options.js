(function () {
	const DEFAULT_CHAT_MAX_WIDTH = 400;
	const DEFAULT_SHOW_SETTINGS_BUTTON = true;
	const DEFAULT_DISABLE_SLEEPER_PLUS = false;
	const DEFAULT_ENABLE_TREND_OVERLAYS = true;
	const DEFAULT_SHOW_OPPONENT_RANKS = true;
	const DEFAULT_SHOW_SPARKLINE_ALWAYS = true;
	const MIN_CHAT_MAX_WIDTH = 200;
	const MAX_CHAT_MAX_WIDTH = 800;
	const LAST_REFRESH_STORAGE_KEY = 'sleeperPlus:lastDataRefresh';

	const form = document.getElementById('league-form');
	const leagueInput = document.getElementById('league-id');
	const addLeagueButton = document.getElementById('add-league-button');
	const leagueList = document.getElementById('league-list');
	const chatWidthInput = document.getElementById('chat-max-width');
	const disableExtensionInput = document.getElementById('disable-sleeper-plus');
	const showButtonInput = document.getElementById('show-settings-button');
	const enableTrendsInput = document.getElementById('enable-trend-overlays');
	const showOpponentRanksInput = document.getElementById('show-opponent-ranks');
	const showSparklineAlwaysInput = document.getElementById('show-sparkline-always');
	const message = document.getElementById('message');
	const saveButton = document.getElementById('save-button');
	const goToLeagueButton = document.getElementById('go-to-league-button');
	const clearButton = document.getElementById('clear-button');
	const refreshDataButton = document.getElementById('refresh-data-button');
	const refreshDataStatus = document.getElementById('refresh-data-status');
	const refreshDataLastRun = document.getElementById('refresh-data-last-run');

	let redirectTimeoutId = null;
	let lastAddedLeagueId = '';
	const state = {
		leagueIds: [],
		chatMaxWidth: DEFAULT_CHAT_MAX_WIDTH,
		showSettingsButton: DEFAULT_SHOW_SETTINGS_BUTTON,
		disableSleeperPlus: DEFAULT_DISABLE_SLEEPER_PLUS,
		enableTrendOverlays: DEFAULT_ENABLE_TREND_OVERLAYS,
		showOpponentRanks: DEFAULT_SHOW_OPPONENT_RANKS,
		showSparklineAlways: DEFAULT_SHOW_SPARKLINE_ALWAYS,
	};

	let refreshInFlight = false;

	const showMessage = (text, type) => {
		message.textContent = text;
		message.className = type ? type : '';
	};

	const withMessage = (text, type, timeout = 3000) => {
		showMessage(text, type);
		if (timeout) {
			setTimeout(() => showMessage('', ''), timeout);
		}
	};

	const setRefreshStatus = (text, type = '') => {
		if (!refreshDataStatus) {
			return;
		}
		refreshDataStatus.textContent = text || '';
		refreshDataStatus.className = type ? `helper ${type}` : 'helper';
	};

	const syncRefreshButtonState = () => {
		if (!refreshDataButton) {
			return;
		}
		refreshDataButton.disabled = refreshInFlight || saveButton.disabled;
	};

	const setRefreshBusy = (isBusy) => {
		if (!refreshDataButton) {
			return;
		}
		refreshInFlight = isBusy;
		refreshDataButton.textContent = isBusy ? 'Refreshing…' : 'Refresh Sleeper data';
		syncRefreshButtonState();
	};

	const getLastRefreshMetadata = () => {
		return new Promise((resolve) => {
			chrome.storage.local.get([LAST_REFRESH_STORAGE_KEY], (result) => {
				if (chrome.runtime.lastError) {
					console.warn('Sleeper+ unable to read refresh metadata', chrome.runtime.lastError);
					resolve(null);
					return;
				}
				resolve(result?.[LAST_REFRESH_STORAGE_KEY] || null);
			});
		});
	};

	const formatRefreshLabel = (meta) => {
		if (!meta || !meta.timestamp) {
			return 'Sleeper data has not been refreshed yet.';
		}
		const formatter = new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
		});
		const formatted = formatter.format(new Date(meta.timestamp));
		const sourceLabel = meta.source === 'manual' ? 'manual refresh' : 'auto refresh';
		const leagueCount = Number(meta.leagueCount);
		const leagueSuffix = Number.isFinite(leagueCount) && leagueCount > 0
			? ` across ${leagueCount} league${leagueCount === 1 ? '' : 's'}`
			: '';
		return `Last refreshed ${formatted} via ${sourceLabel}${leagueSuffix}.`;
	};

	const renderLastRefreshMetadata = (meta) => {
		if (!refreshDataLastRun) {
			return;
		}
		refreshDataLastRun.textContent = formatRefreshLabel(meta);
	};

	const syncLastRefreshMetadata = async () => {
		const meta = await getLastRefreshMetadata();
		renderLastRefreshMetadata(meta);
	};

	if (refreshDataLastRun) {
		renderLastRefreshMetadata(null);
	}

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'local' || !changes[LAST_REFRESH_STORAGE_KEY]) {
			return;
		}
		renderLastRefreshMetadata(changes[LAST_REFRESH_STORAGE_KEY].newValue || null);
	});

	const sendRuntimeMessage = (payload) => {
		return new Promise((resolve, reject) => {
			try {
				chrome.runtime.sendMessage(payload, (response) => {
					if (chrome.runtime.lastError) {
						reject(new Error(chrome.runtime.lastError.message));
						return;
					}
					if (!response) {
						reject(new Error('No response from Sleeper+.'));
						return;
					}
					if (!response.ok) {
						reject(new Error(response.error || 'Sleeper+ request failed.'));
						return;
					}
					resolve(response.result);
				});
			} catch (error) {
				reject(error);
			}
		});
	};

	const normalizeLeagueId = (rawValue) => {
		const trimmed = rawValue.trim();
		if (!trimmed) {
			return '';
		}

		const urlMatch = trimmed.match(/leagues\/([^/?#]+)/i);
		if (urlMatch && urlMatch[1]) {
			return urlMatch[1];
		}

		return trimmed;
	};

	const uniqueLeagueIds = (ids) => {
		const seen = new Set();
		const unique = [];
		ids.forEach((id) => {
			const normalized = normalizeLeagueId(String(id));
			if (normalized && !seen.has(normalized)) {
				seen.add(normalized);
				unique.push(normalized);
			}
		});
		return unique;
	};

	const coerceStoredChatWidth = (value) => {
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

	const validateChatWidth = (value) => {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) {
			return {
				valid: false,
				message: 'Please enter a numeric value for the league chat width.',
			};
		}

		const rounded = Math.round(numeric);
		if (rounded < MIN_CHAT_MAX_WIDTH || rounded > MAX_CHAT_MAX_WIDTH) {
			return {
				valid: false,
				message: `League chat max width must be between ${MIN_CHAT_MAX_WIDTH}px and ${MAX_CHAT_MAX_WIDTH}px.`,
			};
		}

		return {
			valid: true,
			value: rounded,
		};
	};

	const sanitizeStoredSettings = (stored) => {
		const result = stored || {};
		let storedLeagueIds = [];

		if (Array.isArray(result.leagueIds)) {
			storedLeagueIds = result.leagueIds;
		} else if (Array.isArray(result.leagueId)) {
			storedLeagueIds = result.leagueId;
		} else if (result.leagueId) {
			storedLeagueIds = [result.leagueId];
		} else if (result.leagueIds && typeof result.leagueIds === 'string') {
			storedLeagueIds = [result.leagueIds];
		}

		return {
			leagueIds: uniqueLeagueIds(storedLeagueIds),
			chatMaxWidth:
				result.chatMaxWidth !== undefined
					? coerceStoredChatWidth(result.chatMaxWidth)
					: DEFAULT_CHAT_MAX_WIDTH,
			showSettingsButton:
				typeof result.showSettingsButton === 'boolean'
					? result.showSettingsButton
					: DEFAULT_SHOW_SETTINGS_BUTTON,
			disableSleeperPlus:
				typeof result.disableSleeperPlus === 'boolean'
					? result.disableSleeperPlus
					: DEFAULT_DISABLE_SLEEPER_PLUS,
			enableTrendOverlays:
				typeof result.enableTrendOverlays === 'boolean'
					? result.enableTrendOverlays
					: DEFAULT_ENABLE_TREND_OVERLAYS,
			showOpponentRanks:
				typeof result.showOpponentRanks === 'boolean'
					? result.showOpponentRanks
					: DEFAULT_SHOW_OPPONENT_RANKS,
			showSparklineAlways:
				typeof result.showSparklineAlways === 'boolean'
					? result.showSparklineAlways
					: DEFAULT_SHOW_SPARKLINE_ALWAYS,
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
				],
				(result) => resolve(sanitizeStoredSettings(result))
			);
		});
	};

	const setStoredSettings = (settings) => {
		return new Promise((resolve) => {
			chrome.storage.sync.set(settings, () => resolve());
		});
	};

	const clearStoredSettings = () => {
		return new Promise((resolve) => {
			chrome.storage.sync.remove(
				[
					'leagueIds',
					'leagueId',
					'chatMaxWidth',
					'showSettingsButton',
					'disableSleeperPlus',
					'enableTrendOverlays',
					'showOpponentRanks',
					'showSparklineAlways',
				],
				() => resolve()
			);
		});
	};

	const setLoading = (isLoading) => {
		saveButton.disabled = isLoading;
		clearButton.disabled = isLoading;
		goToLeagueButton.disabled = isLoading;
		leagueInput.disabled = isLoading;
		addLeagueButton.disabled = isLoading;
		chatWidthInput.disabled = isLoading;
		disableExtensionInput.disabled = isLoading;
		showButtonInput.disabled = isLoading;
		enableTrendsInput.disabled = isLoading;
		showOpponentRanksInput.disabled = isLoading;
		showSparklineAlwaysInput.disabled = isLoading;
		syncRefreshButtonState();
	};

	const resetRedirectTimer = () => {
		if (redirectTimeoutId) {
			clearTimeout(redirectTimeoutId);
			redirectTimeoutId = null;
		}
	};

	const redirectToLeague = (leagueId) => {
		if (!leagueId) {
			window.location.href = 'https://sleeper.com/leagues/';
			return;
		}

		window.location.href = `https://sleeper.com/leagues/${leagueId}`;
	};

	const renderLeagueList = () => {
		leagueList.innerHTML = '';

		if (state.leagueIds.length === 0) {
			const placeholder = document.createElement('li');
			placeholder.className = 'league-placeholder';
			placeholder.textContent = 'No leagues added yet.';
			leagueList.appendChild(placeholder);
			return;
		}

		state.leagueIds.forEach((id) => {
			const pill = document.createElement('li');
			pill.className = 'league-pill';
			pill.dataset.leagueId = id;

			const text = document.createElement('span');
			text.textContent = id;
			pill.appendChild(text);

			const removeButton = document.createElement('button');
			removeButton.type = 'button';
			removeButton.setAttribute('aria-label', `Remove league ${id}`);
			removeButton.dataset.action = 'remove-league';
			removeButton.dataset.leagueId = id;
			removeButton.textContent = '×';
			pill.appendChild(removeButton);

			leagueList.appendChild(pill);
		});
	};

	const scheduleRedirectToLeague = (leagueId, delayMs = 600) => {
		if (!leagueId) {
			return;
		}

		resetRedirectTimer();
		redirectTimeoutId = setTimeout(() => {
			redirectTimeoutId = null;
			redirectToLeague(leagueId);
		}, delayMs);
	};

	const addLeagueId = () => {
		const normalized = normalizeLeagueId(leagueInput.value);
		if (!normalized) {
			withMessage('Enter a Sleeper league ID or URL before adding.', 'error', 4000);
			return;
		}

		if (state.leagueIds.includes(normalized)) {
			withMessage('That league is already added.', 'error', 4000);
			leagueInput.value = '';
			return;
		}

		state.leagueIds.push(normalized);
		lastAddedLeagueId = normalized;
		leagueInput.value = '';
		renderLeagueList();
		withMessage(`Added league ${normalized}. Press save to confirm.`, 'success', 2500);
	};

	const removeLeagueId = (leagueId) => {
		const index = state.leagueIds.indexOf(leagueId);
		if (index === -1) {
			return;
		}

		state.leagueIds.splice(index, 1);
		if (lastAddedLeagueId === leagueId) {
			lastAddedLeagueId = state.leagueIds[state.leagueIds.length - 1] || '';
		}
		renderLeagueList();
		withMessage(`Removed league ${leagueId}. Press save to confirm.`, 'success', 2500);

		if (state.leagueIds.length === 0) {
			showMessage('Sleeper+ is inactive until you add a league ID.', 'error');
		}
	};

	addLeagueButton.addEventListener('click', addLeagueId);
	leagueInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			addLeagueId();
		}
	});

	leagueList.addEventListener('click', (event) => {
		const target = event.target;
		if (target instanceof HTMLElement && target.dataset.action === 'remove-league') {
			removeLeagueId(target.dataset.leagueId || '');
		}
	});

	goToLeagueButton.addEventListener('click', () => {
		resetRedirectTimer();

		if (state.leagueIds.length === 0) {
			withMessage('Add a league ID before opening a league.', 'error', 4000);
			return;
		}

		const targetLeagueId =
			(lastAddedLeagueId && state.leagueIds.includes(lastAddedLeagueId))
				? lastAddedLeagueId
				: state.leagueIds[0];
		withMessage('Opening your league…', 'success', 1500);
		redirectToLeague(targetLeagueId);
	});

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		resetRedirectTimer();

		const { valid, value: validatedChatWidth, message: chatWidthError } = validateChatWidth(
			chatWidthInput.value
		);

		if (!valid) {
			withMessage(chatWidthError, 'error', 5000);
			return;
		}

		const showSettingsButton = showButtonInput.checked;
		const disableSleeperPlus = disableExtensionInput.checked;
		const enableTrendOverlays = enableTrendsInput.checked;
		const showOpponentRanks = showOpponentRanksInput.checked;
		const showSparklineAlways = showSparklineAlwaysInput.checked;
		const leagueIds = uniqueLeagueIds(state.leagueIds);

		setLoading(true);
		try {
			await setStoredSettings({
				leagueIds,
				chatMaxWidth: validatedChatWidth,
				showSettingsButton,
				disableSleeperPlus,
				enableTrendOverlays,
				showOpponentRanks,
				showSparklineAlways,
			});

			state.leagueIds = leagueIds;
			state.chatMaxWidth = validatedChatWidth;
			state.showSettingsButton = showSettingsButton;
			state.disableSleeperPlus = disableSleeperPlus;
			state.enableTrendOverlays = enableTrendOverlays;
			state.showOpponentRanks = showOpponentRanks;
			state.showSparklineAlways = showSparklineAlways;

			renderLeagueList();

			if (disableSleeperPlus) {
				withMessage(
					'Settings saved. Sleeper+ enhancements are disabled until you toggle them back on.',
					'success',
					5000
				);
			} else if (leagueIds.length > 0) {
				const redirectId = lastAddedLeagueId && leagueIds.includes(lastAddedLeagueId)
					? lastAddedLeagueId
					: leagueIds[0];
				withMessage('Settings saved. Redirecting to your league…', 'success', 0);
				scheduleRedirectToLeague(redirectId);
			} else {
				withMessage(
					'Settings saved. Sleeper+ stays inactive until you add a league ID.',
					'success',
					5000
				);
			}
		} catch (error) {
			console.error('Failed to save Sleeper+ settings', error);
			withMessage(
				'Unable to save settings. Check the console for details.',
				'error',
				6000
			);
		} finally {
			setLoading(false);
		}
	});

	clearButton.addEventListener('click', async () => {
		resetRedirectTimer();

		if (!window.confirm('Reset all Sleeper+ settings? This action cannot be undone.')) {
			return;
		}

		setLoading(true);

		try {
			await clearStoredSettings();
			state.leagueIds = [];
			state.chatMaxWidth = DEFAULT_CHAT_MAX_WIDTH;
			state.showSettingsButton = DEFAULT_SHOW_SETTINGS_BUTTON;
			state.disableSleeperPlus = DEFAULT_DISABLE_SLEEPER_PLUS;
			state.enableTrendOverlays = DEFAULT_ENABLE_TREND_OVERLAYS;
			state.showOpponentRanks = DEFAULT_SHOW_OPPONENT_RANKS;
			state.showSparklineAlways = DEFAULT_SHOW_SPARKLINE_ALWAYS;
			lastAddedLeagueId = '';

			leagueInput.value = '';
			chatWidthInput.value = DEFAULT_CHAT_MAX_WIDTH;
			disableExtensionInput.checked = DEFAULT_DISABLE_SLEEPER_PLUS;
			showButtonInput.checked = DEFAULT_SHOW_SETTINGS_BUTTON;
			enableTrendsInput.checked = DEFAULT_ENABLE_TREND_OVERLAYS;
			showOpponentRanksInput.checked = DEFAULT_SHOW_OPPONENT_RANKS;
			showSparklineAlwaysInput.checked = DEFAULT_SHOW_SPARKLINE_ALWAYS;
			setRefreshStatus('');
			setRefreshBusy(false);
			renderLeagueList();

			withMessage(
				'Settings cleared. Sleeper+ is inactive until a league ID is added.',
				'success',
				5000
			);
		} catch (error) {
			console.error('Failed to clear Sleeper+ settings', error);
			withMessage(
				'Unable to clear settings. Check the console for details.',
				'error',
				6000
			);
		} finally {
			setLoading(false);
		}
	});

	refreshDataButton.addEventListener('click', async () => {
		resetRedirectTimer();
		if (refreshInFlight) {
			return;
		}

		if (state.leagueIds.length === 0) {
			setRefreshStatus('Add a league ID before refreshing.', 'error');
			withMessage('Add a league ID before refreshing data.', 'error', 4000);
			return;
		}

		setRefreshBusy(true);
		setRefreshStatus('Refreshing Sleeper data…');
		try {
			await sendRuntimeMessage({
				type: 'SLEEPER_PLUS_FORCE_REFRESH',
				leagueIds: state.leagueIds,
			});
			setRefreshStatus('Data refresh requested. Updates may take a moment.', 'success');
			withMessage('Sleeper data refresh requested.', 'success', 4000);
			await syncLastRefreshMetadata();
		} catch (error) {
			console.error('Sleeper+ manual refresh failed', error);
			setRefreshStatus('Refresh failed. Check the console for details.', 'error');
			withMessage('Unable to refresh data. See console for details.', 'error', 5000);
		} finally {
			setRefreshBusy(false);
		}
	});

	(async () => {
		setLoading(true);
		try {
			const stored = await getStoredSettings();
			state.leagueIds = stored.leagueIds;
			state.chatMaxWidth = stored.chatMaxWidth;
			state.showSettingsButton = stored.showSettingsButton;
			state.disableSleeperPlus = stored.disableSleeperPlus;
			state.enableTrendOverlays = stored.enableTrendOverlays;
			state.showOpponentRanks = stored.showOpponentRanks;
			state.showSparklineAlways = stored.showSparklineAlways;
			lastAddedLeagueId = state.leagueIds[state.leagueIds.length - 1] || '';

			renderLeagueList();
			chatWidthInput.value = state.chatMaxWidth;
			disableExtensionInput.checked = state.disableSleeperPlus;
			showButtonInput.checked = state.showSettingsButton;
			enableTrendsInput.checked = state.enableTrendOverlays;
			showOpponentRanksInput.checked = state.showOpponentRanks;
			showSparklineAlwaysInput.checked = state.showSparklineAlways;
			setRefreshStatus('');
			await syncLastRefreshMetadata();

			if (state.leagueIds.length === 0) {
				showMessage('Sleeper+ is inactive until you add a league ID.', 'error');
			} else if (state.disableSleeperPlus) {
				showMessage('Sleeper+ enhancements are currently disabled.', 'error');
			}
		} catch (error) {
			console.error('Failed to load Sleeper+ settings', error);
			withMessage('Unable to load settings. Try refreshing.', 'error', 6000);
		} finally {
			setLoading(false);
		}
	})();
})();
