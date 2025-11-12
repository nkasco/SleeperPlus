# Sleeper+
Chrome Extension to enhance the desktop web experience for Sleeper Fantasy Football.

## Development

- Load the extension by navigating to `chrome://extensions`, enabling Developer mode, and using **Load unpacked** on this folder.
- The extension will prompt for a league ID on first install. Enter the numeric string from your Sleeper league URL.
- After saving a league ID, the options page redirects you to `https://sleeper.com/leagues/<leagueId>` and Sleeper+ will:
  - Inject a plus-icon "Sleeper+ Settings" control styled like the existing `settings-header-container` (toggleable in the options) so you can reopen settings quickly.
  - Expand `.center-panel` to fill the remaining flex space and fix `.right-panel` to your configured chat width (default 400px) as requested.
- Additional options let you change the league chat maximum width (200–800px) and choose whether the Sleeper+ button is shown.
- You can save layout preferences without a league ID; Sleeper+ remains inactive until one is provided, at which point the options page will auto-redirect to that league.
- Clearing the league ID from the options page disables all Sleeper+ changes until you save a new one.

## Project Structure

- `manifest.json`: Chrome Manifest V3 configuration.
- `background/service_worker.js`: opens the options page on install so a league ID can be provided immediately.
- `options/`: options UI for managing the league ID.
- `content/content.js`: activates on matching league pages, injects the button, and applies layout overrides.
