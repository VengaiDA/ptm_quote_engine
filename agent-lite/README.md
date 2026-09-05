# PTM Agent Lite

`agent-lite/` is an isolated static PWA for PTM agents. It is deliberately separate from the root PTM Quote Engine and is served at:

`https://vengaida.github.io/ptm_quote_engine/agent-lite/`

## v0.1 scope

- Embedded September campaign artwork with download and native-share fallback.
- Public Complete Package enquiry estimate only: $70/night; 7+ 5%, 14+ 10%, 21+ 15%, 30+ 20%.
- Local-only activity stored in the browser; no login, API, database, analytics, margin, override, admin, or executive data.
- A scoped service worker for offline reuse after the first successful visit.

The root `index.html` Quote Engine is intentionally not part of this app.
