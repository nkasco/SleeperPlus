<h1 align="center" style="font-size:3rem; font-weight:700;">
  <img src="images/icon1024.png" alt="Sleeper+ icon" width="200" style="vertical-align:middle; margin-right:12px;" />
</h1>

<p align="center">
  Sleeper+ supercharges Sleeper Fantasy Football on desktop with trend overlays, richer matchup context, and a dialed-in layout built for true league obsessives.
</p>

<p align="center">
  <a href="https://example.com/sleeper-plus-downloads" target="_blank"><img src="https://img.shields.io/endpoint?url=https://example.com/api/sleeperplus/downloads.json&label=Chrome%20Downloads&color=ff6b6b" alt="Sleeper+ download badge"></a>
  <img src="https://img.shields.io/badge/manifest-v3-6a5acd" alt="Manifest V3 badge">
  <img src="https://img.shields.io/badge/status-active-success" alt="Active status badge">
</p>

## Features

- ✨ **Dynamic Trend Overlays** &nbsp;— &nbsp;<span style="color:#ff6b6b;">colorful sparkline overlays</span> add instant matchup temperature to every roster.
- 🟣 **Opponent Rank Chips** &nbsp;— &nbsp;<span style="color:#a36af8;">bold rank indicators</span> highlight weekly difficulty beside each player name.
- 💬 **Custom Chat Layouts** &nbsp;— &nbsp;<span style="color:#20c997;">flex-based resizing</span> keeps the banter roomy without sacrificing roster views.
- ⚙️ **One-Click Sleeper+ Button** &nbsp;— &nbsp;<span style="color:#f7b731;">inline controls</span> let you reopen settings anywhere inside Sleeper.
- 🔄 **Hourly Data Refresh** &nbsp;— &nbsp;<span style="color:#4dabf7;">automatic syncs</span> (with manual overrides) ensure the freshest player intel.

## Support

Run into bugs or have a feature idea? Head over to the project issues at [github.com/nkasco/Sleeper-/issues](https://github.com/nkasco/SleeperPlus/issues) and open a ticket—issues and suggestions all live there.

## Project Structure

- `manifest.json` — Manifest V3 definition of permissions, scripts, and extension metadata.
- `background/service_worker.js` — Install-time bootstrap that opens the options page and listens for refresh commands.
- `content/content.js` — Injected into Sleeper league pages to add UI controls, trend overlays, and layout tweaks.
- `options/` — Options dashboard (`options.html`, `options.js`, `options.css`) for managing leagues, feature toggles, and manual refreshes.
- `images/` — Icon set (16–1024px) used for the Chrome Web Store listing and README branding.
- `privacypolicy.txt` & `LICENSE` — Policy and MIT license docs included in the packaged extension.

## Credits

Sleeper+ is designed and built entirely by **Nathan Kasco**. I couldn’t find anything like this that delivered the Sleeper experience I wanted, so I built it myself.