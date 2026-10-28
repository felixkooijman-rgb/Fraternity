'use strict';
// Builds the poster as an SVG string. All text stays live <text> so the master
// stays editable; fonts are embedded as base64 @font-face so the SVG is self-contained.
//
// Coordinate system: the trim area is 2000 × 3000 units (2:3). Bleed extends
// outside it (negative coordinates / beyond 2000×3000). Final pixel sizes are
// chosen at export time, so the layout never depends on output resolution.

const fs = require('fs');
const path = require('path');
const { formatMinute } = require('./validate');

const W = 2000;
const H = 3000;
const CX = W / 2;

const FONT_DIR = path.join(__dirname, '..', 'fonts');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function upper(s) {
  return String(s).toLocaleUpperCase('en');
}

function fontFaces() {
  const b64 = (f) => fs.readFileSync(path.join(FONT_DIR, f)).toString('base64');
  return `
    @font-face { font-family: 'Poster Display'; src: url(data:font/ttf;base64,${b64('Anton-Regular.ttf')}) format('truetype'); }
    @font-face { font-family: 'Poster Text'; font-weight: 200 700; src: url(data:font/ttf;base64,${b64('Oswald-Variable.ttf')}) format('truetype'); }`;
}

// Deterministic PRNG so the same match always gets the same torn edges.
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// A vertical edge from y0 to y1 around x, with small irregular "torn" steps.
function tornEdge(rand, x, y0, y1) {
  const pts = [];
  let y = y0;
  const dir = y1 > y0 ? 1 : -1;
  while ((y1 - y) * dir > 0) {
    const big = rand() < 0.08;
    const dx = (rand() - 0.5) * (big ? 22 : 9);
    pts.push([x + dx, y]);
    y += dir * (14 + rand() * 46);
  }
  pts.push([x + (rand() - 0.5) * 8, y1]);
  return pts;
}

function stripe(rand, x0, x1, y0, y1) {
  const left = tornEdge(rand, x0, y0, y1);
  const right = tornEdge(rand, x1, y1, y0);
  const d = [...left, ...right].map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return `${d} Z`;
}

// A slanted shirt fragment (collar piece / lower stripe) with torn long edges.
function fragment(rand, xl, xr, yTop, yBottom, slant) {
  const left = tornEdge(rand, xl, yTop + slant, yBottom).map(([x, y]) => [x, y]);
  const right = tornEdge(rand, xr, yBottom, yTop);
  const d = [...left, ...right].map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return `${d} Z`;
}

function text(x, y, str, { size, family = 'Poster Text', weight = 600, anchor = 'middle', fill, ls = 0, maxw, outline, qa = true, id } = {}) {
  const attrs = [
    id ? `id="${id}"` : '',
    `x="${x}"`, `y="${y}"`,
    `font-family="${family}"`, `font-size="${size}"`, `font-weight="${weight}"`,
    `text-anchor="${anchor}"`, `fill="${fill}"`,
    ls ? `letter-spacing="${ls}"` : '',
    maxw ? `data-maxw="${maxw}"` : '',
    qa ? 'data-qa="1"' : '',
    outline ? `stroke="${outline.color}" stroke-width="${outline.width}" stroke-linejoin="round" paint-order="stroke"` : '',
  ].filter(Boolean).join(' ');
  return `<text ${attrs}>${esc(str)}</text>`;
}

function rule(y, color, x0 = 400, x1 = 1600) {
  return `<rect x="${x0}" y="${y - 2.5}" width="${x1 - x0}" height="5" fill="${color}"/>`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function buildSvg(data, theme, opts = {}) {
  const bleed = opts.bleed ?? 12; // ≈3 mm when the trim is 50.8 cm wide
  const brandLogo = opts.brandLogo || null; // SVG markup of the official logo, if provided
  const c = theme.colors;
  const rand = rng(data.slug || 'poster');
  const F = 36; // frame width
  const art = { x: F, y: F, w: W - 2 * F, h: H - 2 * F };
  const ax = (r) => art.x + r * art.w;
  const ay = (r) => art.y + r * art.h;
  const { match, goals = [], featured, lineups, display = {} } = data;
  const out = [];

  // ---------- background + shirt graphics (clipped to the art area) ----------
  out.push(`<rect x="${-bleed}" y="${-bleed}" width="${W + 2 * bleed}" height="${H + 2 * bleed}" fill="${c.frame}"/>`);
  out.push(`<g clip-path="url(#art)">`);
  out.push(`<rect x="${art.x}" y="${art.y}" width="${art.w}" height="${art.h}" fill="${c.background}"/>`);
  const sp = theme.stripes || {};
  if (sp.side) {
    out.push(`<path d="${stripe(rand, ax(0.043), ax(0.146), art.y - 20, art.y + art.h + 20)}" fill="${c.stripe}"/>`);
    out.push(`<path d="${stripe(rand, ax(0.854), ax(0.958), art.y - 20, art.y + art.h + 20)}" fill="${c.stripe}"/>`);
  }
  if (sp.collar) {
    out.push(`<path d="${fragment(rand, ax(0.33), ax(0.39), art.y - 10, ay(0.042), 0)}" fill="${c.stripe}" transform="rotate(-3 ${ax(0.36)} ${ay(0.02)})"/>`);
    out.push(`<path d="${fragment(rand, ax(0.61), ax(0.665), art.y - 10, ay(0.036), 0)}" fill="${c.stripe}" transform="rotate(4 ${ax(0.64)} ${ay(0.02)})"/>`);
  }
  if (sp.lowerShirt) {
    out.push(`<path d="${fragment(rand, ax(0.327), ax(0.386), ay(0.80), art.y + art.h + 20, 6)}" fill="${c.stripe}"/>`);
    out.push(`<path d="${fragment(rand, ax(0.61), ax(0.675), ay(0.80), art.y + art.h + 20, -8)}" fill="${c.stripe}"/>`);
  }
  out.push(`</g>`);

  // ---------- header ----------
  const SEP = '\u2002|\u2002'; // en spaces survive SVG whitespace collapsing
  const header1 = `${upper(match.stadium)}${SEP}${formatDate(match.date)}`;
  const header2 = `${upper(match.competition)}${match.phase ? `${SEP}${upper(match.phase)}` : ''}`;
  out.push(text(CX, 255, header1, { size: 58, weight: 600, fill: c.text, ls: 2, maxw: 1180 }));
  out.push(text(CX, 330, header2, { size: 52, weight: 600, fill: c.text, ls: 2, maxw: 1180 }));
  out.push(rule(380, c.rule));
  out.push(text(CX, 437, upper(featured.headline), { size: 34, weight: 500, fill: c.text, ls: 1, maxw: 1150 }));
  out.push(rule(476, c.rule));

  // ---------- decisive minute ----------
  if (featured.moment) {
    out.push(text(CX, 680, formatMinute(featured.moment), { size: 168, weight: 700, fill: c.text, maxw: 900 }));
  }
  out.push(rule(746, c.rule));

  // ---------- score ----------
  const scoreY = 900;
  out.push(text(CX, scoreY, `${match.score.home}:${match.score.away}`, { size: 112, weight: 600, fill: c.text, id: 'score' }));
  out.push(text(CX - 115, scoreY, upper(match.home.display), { size: 112, weight: 600, fill: c.text, anchor: 'end', maxw: 480 }));
  out.push(text(CX + 115, scoreY, upper(match.away.display), { size: 112, weight: 600, fill: c.text, anchor: 'start', maxw: 480 }));
  if (display.showScorers !== false) {
    const list = (side) => goals.filter((g) => g.team === side)
      .map((g) => `${upper(g.display)}${g.type === 'penalty' ? ' (P)' : g.type === 'own_goal' ? ' (OG)' : ''} ${formatMinute(g)}`)
      .join(SEP);
    const home = list('home');
    const away = list('away');
    if (home) out.push(text(CX - 100, 958, home, { size: 27, weight: 500, fill: c.text, anchor: 'end', maxw: 590 }));
    if (away) out.push(text(CX + 100, 958, away, { size: 27, weight: 500, fill: c.text, anchor: 'start', maxw: 590 }));
  }
  out.push(rule(1006, c.rule));

  // ---------- featured player ----------
  const p = featured.player;
  out.push(text(CX, 1325, upper(p.display), { size: 300, family: 'Poster Display', weight: 400, fill: c.text, ls: 14, maxw: 1250, id: 'surname' }));
  const num = String(p.number);
  const numSize = 1080;
  const numY = 2290;
  const numAttrs = `font-family="Poster Display" font-size="${numSize}" text-anchor="middle"`;
  out.push(`<g id="number">`);
  out.push(`<text x="${CX + 30}" y="${numY + 30}" ${numAttrs} fill="${c.accent}">${esc(num)}</text>`);
  out.push(`<text x="${CX + 16}" y="${numY + 16}" ${numAttrs} fill="${c.numberGap}">${esc(num)}</text>`);
  out.push(`<text x="${CX}" y="${numY}" ${numAttrs} fill="${c.text}" data-qa="1" data-maxw="1250">${esc(num)}</text>`);
  out.push(`</g>`);
  out.push(rule(2395, c.rule));

  // ---------- line-ups ----------
  const outline = { color: c.nameOutline, width: 7 };
  if (lineups && display.showLineups !== false) {
    const rowY = [2560, 2632, 2704, 2776];
    const zones = { home: [ax(0.03), ax(0.405)], away: [ax(0.595), ax(0.97)] };
    for (const side of ['home', 'away']) {
      const rows = lineups[side].rows || [];
      const [z0, z1] = zones[side];
      rows.forEach((row, r) => {
        const step = (z1 - z0) / row.length;
        row.forEach((name, i) => {
          out.push(text(z0 + step * (i + 0.5), rowY[r] ?? rowY[rowY.length - 1] + 72 * (r - 3), upper(name),
            { size: 30, weight: 600, fill: c.text, outline, maxw: step - 22 }));
        });
      });
    }
  }
  if (lineups && display.showSubs !== false) {
    out.push(`<rect x="${CX - 2.5}" y="2425" width="5" height="${H - F - 40 - 2425}" fill="${c.rule}"/>`);
    const cols = { home: CX - 105, away: CX + 105 };
    const bottom = H - F - 52;
    for (const side of ['home', 'away']) {
      const l = lineups[side];
      const lines = [];
      if (l.manager) lines.push({ t: upper(l.manager), size: 28, weight: 600, gap: 50 });
      [...(l.subs || [])].reverse().forEach((s) => lines.push({ t: upper(s), size: 25, weight: 500, gap: 33 }));
      lines.push({ t: 'SUBS', size: 28, weight: 600, gap: 44 });
      let y = bottom;
      for (const ln of lines) {
        out.push(text(cols[side], y, ln.t, { size: ln.size, weight: ln.weight, fill: c.text, maxw: 190 }));
        y -= ln.gap;
      }
    }
  }

  // ---------- brand ----------
  const brandX = ax(0.906);
  const brandY = H - F - 42;
  if (brandLogo) {
    out.push(`<g transform="translate(${brandX - 110} ${brandY - 34})">${brandLogo}</g>`);
  } else {
    out.push(text(brandX, brandY, upper(data.brand?.name || 'FRATERNITY'), { size: 30, weight: 700, fill: c.brand, ls: 1.5, maxw: 210 }));
  }

  const safe = { x: art.x + 20, y: art.y + 20, w: art.w - 40, h: art.h - 40 };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-bleed} ${-bleed} ${W + 2 * bleed} ${H + 2 * bleed}" width="${W + 2 * bleed}" height="${H + 2 * bleed}" data-safe="${safe.x} ${safe.y} ${safe.w} ${safe.h}" data-trim="0 0 ${W} ${H}">
<title>${esc(`${match.home.display} ${match.score.home}:${match.score.away} ${match.away.display} – ${p.display} ${p.number}`)}</title>
<defs><style>${fontFaces()}</style><clipPath id="art"><rect x="${art.x}" y="${art.y}" width="${art.w}" height="${art.h}"/></clipPath></defs>
${out.join('\n')}
</svg>`;
  return { svg, W, H, bleed };
}

module.exports = { buildSvg };
