#!/usr/bin/env node
'use strict';
// Usage: node poster/collection.js <collection-id> [--variant framed]
//
// Builds an overview of every match file with "collection": <collection-id>:
//   output/collections/<id>/overview-2048.jpg   2048×2048 contact sheet (chronological)
//   output/collections/<id>/README.md           the list: moment, match, files, open checks
// Render the posters first (node poster/render.js …).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { formatMinute } = require('./lib/validate');

const ROOT = path.join(__dirname, '..');
const SIZE = 2048;

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

async function main() {
  const args = process.argv.slice(2);
  const id = args[0];
  const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'framed';
  if (!id) {
    console.error('usage: node poster/collection.js <collection-id> [--variant framed]');
    process.exit(2);
  }
  const items = fs.readdirSync(path.join(ROOT, 'matches'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'matches', f), 'utf8')))
    .filter((d) => d.collection === id)
    .sort((a, b) => a.match.date.localeCompare(b.match.date))
    .map((d) => {
      const slug = d.variants ? `${d.slug}-${variant}` : d.slug;
      return { d, slug, preview: path.join(ROOT, 'output', slug, 'preview.jpg') };
    });
  const missing = items.filter((i) => !fs.existsSync(i.preview));
  if (!items.length || missing.length) {
    console.error(items.length ? `not rendered yet: ${missing.map((m) => m.slug).join(', ')}` : `no match files in collection "${id}"`);
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'output', 'collections', id);
  fs.mkdirSync(outDir, { recursive: true });

  // Contact sheet: pick the column count that gives the largest 2:3 posters in the square.
  const gap = 48;
  const fit = (c) => {
    const r = Math.ceil(items.length / c);
    return Math.floor(Math.min((SIZE - gap * (c + 1)) / c, ((SIZE - gap * (r + 1)) / r) * 2 / 3));
  };
  let cols = 1;
  for (let c = 2; c <= items.length; c++) if (fit(c) > fit(cols)) cols = c;
  const cellW = fit(cols);
  const cellH = Math.round(cellW * 1.5);
  const imgs = items.map((i) => `<img src="data:image/jpeg;base64,${fs.readFileSync(i.preview).toString('base64')}" style="width:${cellW}px;height:${cellH}px;box-shadow:0 12px 28px rgba(0,0,0,.22)">`).join('');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:${SIZE}px;height:${SIZE}px;background:#fff;display:flex;align-items:center;justify-content:center">
      <div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:${gap}px">${imgs}</div></body></html>`);
    await page.screenshot({ path: path.join(outDir, 'overview-2048.jpg'), type: 'jpeg', quality: 90 });
  } finally {
    await browser.close();
  }

  const lines = [`# Collectie: ${id}`, '', `${items.length} posters, chronologisch. Elke poster: \`print.pdf\`, \`print.png\`, \`poster.svg\`, \`shop-2048.jpg\` (2048×2048) en \`sources.md\`, in een versie met en zonder lijst.`, ''];
  lines.push('| # | Moment | Wedstrijd | Datum | Speler | Map |', '|---|---|---|---|---|---|');
  items.forEach(({ d, slug }, n) => {
    const m = d.match;
    const p = d.featured.player || d.featured.club;
    const when = d.featured.moment && d.featured.moment.kind === 'goal' ? formatMinute(d.featured.moment) : 'shootout';
    lines.push(`| ${n + 1} | ${d.featured.headline} | ${m.home.name} ${m.score.home}-${m.score.away} ${m.away.name} (${m.competition}, ${m.phase}) | ${formatDate(m.date)} | ${p.display} #${p.number ?? p.mark} – ${when} | \`output/${slug.replace(new RegExp(`-${variant}$`), '')}-*\` |`);
  });
  lines.push('', '## Nog handmatig te controleren', '');
  items.forEach(({ d }) => {
    lines.push(`**${d.featured.player ? d.featured.player.display : d.featured.club.display} – ${formatDate(d.match.date)}**`, '');
    for (const c of d.verification.needs_manual_check || []) lines.push(`- [ ] ${c}`);
    lines.push('');
  });
  fs.writeFileSync(path.join(outDir, 'README.md'), lines.join('\n'));
  console.log(`done  ${path.relative(ROOT, outDir)}/ (overview-2048.jpg, README.md)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
