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

Output in `output/<slug>/`: `poster.svg` (editable master), `print.pdf` (vector, 3 mm bleed), `print.png` (6000 × 9000 trim @ 300 dpi + bleed, not committed), `preview.jpg`, `match.json`, `sources.md`, `qa-report.json`.

Rendering stops on data errors (score ≠ goals, featured goal missing, player not in squad, no sources, …) and exits non-zero on layout errors (overlaps, text outside the safe area). Items in `verification.needs_manual_check` are printed as warnings and listed in `sources.md`.

Fonts: Anton and Oswald (SIL Open Font License, see `poster/fonts/`). Put the official brand logo at `poster/assets/brand/logo.svg` to replace the text wordmark.
