# Fraternity – football poster production

Reusable system for premium, print-ready football match posters.

- **Agent:** `.claude/agents/football-poster-designer.md` – researches & verifies match data, writes the match file, renders and QA's the poster. In Claude Code: *"Use the football-poster-designer agent to make a poster of …"*.
- **Data:** `matches/<slug>.json` (start from `matches/_template.json`).
- **Themes:** `poster/themes/<club>.json`.
- **Renderer:** `poster/render.js` (Node + Playwright/Chromium).

```bash
npm install
```

```bash
node poster/render.js matches/2024-11-27-psv-shakhtar-tillman.json
```

Output in `output/<slug>/`: `poster.svg` (editable master), `print.pdf` (vector, 3 mm bleed), `print.png` (6000 × 9000 trim @ 300 dpi + bleed, not committed), `preview.jpg`, `shop-2048.jpg` (2048 × 2048 square shop image), `match.json`, `sources.md`, `qa-report.json`.

Rendering stops on data errors (score ≠ goals, featured goal missing, player not in squad, no sources, …) and exits non-zero on layout errors (overlaps, text outside the safe area). Items in `verification.needs_manual_check` are printed as warnings and listed in `sources.md`.

Fonts: Anton and Oswald (SIL Open Font License, see `poster/fonts/`). The Fraternity mark (`poster/assets/brand/fraternity-mark.svg`, redrawn from the reference) sits left of the wordmark; replace it with the official file under the same name. Use `"variants"` in a match file to render e.g. a version with and without line-ups.

Collections: give match files the same `"collection"` id and run

```bash
node poster/collection.js nederlandse-voetbalmomenten
```

to get `output/collections/<id>/overview-2048.jpg` (contact sheet) and a `README.md` list with every open check.

## Stadium map posters

City-map posters with the stadium highlighted in club colour (white streets, grey buildings, title block at the bottom). One file per stadium in `stadiums/` (name, OSM name, city, club, colour – no hand-typed coordinates).

```bash
node poster/stadium-map.js --all --fetch
```

`--fetch` downloads the map extract from the Overpass API (host `overpass-api.de` must be reachable; override with `OVERPASS_URL`) and caches it in `stadiums/cache/`; later renders work offline from the cache. Output: `output/stadium-<slug>-{framed,frameless}/` with `poster.svg`, `print.pdf`, `print.png`, `preview.jpg`, `shop-2048.jpg`.

Map data © OpenStreetMap contributors (ODbL 1.0): commercial prints are allowed, the attribution printed on the poster is required and must stay.
