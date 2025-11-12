(function () {
	const DEFAULT_CHAT_MAX_WIDTH = 400;
	const DEFAULT_SHOW_SETTINGS_BUTTON = true;
	const MIN_CHAT_MAX_WIDTH = 200;
	const MAX_CHAT_MAX_WIDTH = 800;

	const form = document.getElementById('league-form');
	const leagueInput = document.getElementById('league-id');
	const addLeagueButton = document.getElementById('add-league-button');
	const leagueList = document.getElementById('league-list');
	const chatWidthInput = document.getElementById('chat-max-width');
	const showButtonInput = document.getElementById('show-settings-button');
	const message = document.getElementById('message');
	const saveButton = document.getElementById('save-button');
	const clearButton = document.getElementById('clear-button');

	let redirectTimeoutId = null;
	let lastAddedLeagueId = '';
	const state = {
		leagueIds: [],
		chatMaxWidth: DEFAULT_CHAT_MAX_WIDTH,
		showSettingsButton: DEFAULT_SHOW_SETTINGS_BUTTON,
	};

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
		};
	};

	const getStoredSettings = () => {
		return new Promise((resolve) => {
			chrome.storage.sync.get(
				['leagueIds', 'leagueId', 'chatMaxWidth', 'showSettingsButton'],
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
				['leagueIds', 'leagueId', 'chatMaxWidth', 'showSettingsButton'],
				() => resolve()
			);
		});
	};

	const setLoading = (isLoading) => {
		saveButton.disabled = isLoading;
		clearButton.disabled = isLoading;
		leagueInput.disabled = isLoading;
		addLeagueButton.disabled = isLoading;
		chatWidthInput.disabled = isLoading;
		showButtonInput.disabled = isLoading;
	};

	const resetRedirectTimer = () => {
		if (redirectTimeoutId) {
			clearTimeout(redirectTimeoutId);
			redirectTimeoutId = null;
		}
	};

	const redirectToLeague = (leagueId) => {
		window.location.href = `https://sleeper.com/leagues/`;
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
		const leagueIds = uniqueLeagueIds(state.leagueIds);

		setLoading(true);
		try {
			await setStoredSettings({
				leagueIds,
				chatMaxWidth: validatedChatWidth,
				showSettingsButton,
			});

			state.leagueIds = leagueIds;
			state.chatMaxWidth = validatedChatWidth;
			state.showSettingsButton = showSettingsButton;

			renderLeagueList();

			if (leagueIds.length > 0) {
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
		setLoading(true);

		try {
			await clearStoredSettings();
			state.leagueIds = [];
			state.chatMaxWidth = DEFAULT_CHAT_MAX_WIDTH;
			state.showSettingsButton = DEFAULT_SHOW_SETTINGS_BUTTON;
			lastAddedLeagueId = '';

			leagueInput.value = '';
			chatWidthInput.value = DEFAULT_CHAT_MAX_WIDTH;
			showButtonInput.checked = DEFAULT_SHOW_SETTINGS_BUTTON;
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

	(async () => {
		setLoading(true);
		try {
			const stored = await getStoredSettings();
			state.leagueIds = stored.leagueIds;
			state.chatMaxWidth = stored.chatMaxWidth;
			state.showSettingsButton = stored.showSettingsButton;
			lastAddedLeagueId = state.leagueIds[state.leagueIds.length - 1] || '';

			renderLeagueList();
			chatWidthInput.value = state.chatMaxWidth;
			showButtonInput.checked = state.showSettingsButton;

			if (state.leagueIds.length === 0) {
				showMessage('Sleeper+ is inactive until you add a league ID.', 'error');
			}
		} catch (error) {
			console.error('Failed to load Sleeper+ settings', error);
			withMessage('Unable to load settings. Try refreshing.', 'error', 6000);
		} finally {
			setLoading(false);
		}
	})();
})();
