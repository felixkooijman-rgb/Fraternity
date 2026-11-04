#!/usr/bin/env node
'use strict';
// Stadium map posters (city-map style: white streets, grey buildings, the stadium in club colour).
//
// Usage:
//   node poster/stadium-map.js stadiums/<slug>.json            render from the cached OSM extract
//   node poster/stadium-map.js stadiums/<slug>.json --fetch    (re)download the extract from Overpass first
//   node poster/stadium-map.js --all [--fetch]                 every file in stadiums/
//
// Map data: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
// The licence allows commercial prints but REQUIRES the attribution, so it is always printed.
//
// Output in output/stadium-<slug>-{framed,frameless}/: poster.svg, print.pdf, print.png,
// preview.jpg, shop-2048.jpg.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FONT_DIR = path.join(__dirname, 'fonts');
const CACHE_DIR = path.join(ROOT, 'stadiums', 'cache');
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const W = 2000;
const H = 3000;
const BLEED = 12;
const PRINT_SCALE = 3;

const STYLE = {
  paper: '#FFFFFF',
  building: '#CFCFCF',
  water: '#DADADA',
  green: '#F1F1F1',
  rail: '#9A9A9A',
  ink: '#111111',
  // stroke widths in poster units, by highway class
  roads: {
    motorway: 9, trunk: 8, primary: 7, secondary: 5.5, tertiary: 4.5,
    motorway_link: 5, trunk_link: 5, primary_link: 4.5, secondary_link: 4, tertiary_link: 3.5,
    residential: 2.6, unclassified: 2.6, living_street: 2.2, service: 1.4,
    pedestrian: 1.4, footway: 0.9, cycleway: 0.9, path: 0.8, track: 0.8, steps: 0.8,
  },
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Overpass ----------

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'fraternity-stadium-posters/1.0' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Finds the stadium by name (and optional country) so no coordinates have to be typed in.
async function locate(cfg) {
  const area = cfg.country ? `area["ISO3166-1"="${cfg.country}"][admin_level=2]->.a;` : '';
  const within = cfg.country ? '(area.a)' : '';
  const name = cfg.osmName || cfg.name;
  const q = `[out:json][timeout:60];${area}nwr["leisure"="stadium"]["name"~"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",i]${within};out center tags 5;`;
  const r = await overpass(q);
  const el = r.elements[0];
  if (!el) throw new Error(`stadium "${name}" not found in OpenStreetMap – set "osmName" to the exact OSM name or give "center"`);
  return { lat: el.lat ?? el.center.lat, lon: el.lon ?? el.center.lon, osm: `${el.type}/${el.id}` };
}

function bboxAround(center, widthM) {
  // 2:3 portrait box (height = 1.5 × width) around the centre, shifted up so the stadium
  // sits in the upper half and the title block has room underneath (like the reference).
  const latM = 111320;
  const lonM = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const hM = widthM * 1.5;
  const south = center.lat - (hM * 0.58) / latM;
  const north = center.lat + (hM * 0.42) / latM;
  const west = center.lon - widthM / 2 / lonM;
  const east = center.lon + widthM / 2 / lonM;
  return { south, west, north, east };
}

async function fetchExtract(cfg) {
  const center = cfg.center ? { lat: cfg.center[0], lon: cfg.center[1] } : await locate(cfg);
  const bb = bboxAround(center, cfg.widthM || 1600);
  const b = `${bb.south},${bb.west},${bb.north},${bb.east}`;
  const q = `[out:json][timeout:180];(
    way["highway"](${b});
    way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"](${b});
    way["building"](${b}); relation["building"](${b});
    way["natural"="water"](${b}); relation["natural"="water"](${b}); way["waterway"~"^(river|canal)$"](${b});
    way["leisure"~"^(park|stadium|pitch)$"](${b}); relation["leisure"~"^(park|stadium)$"](${b});
    way["landuse"~"^(grass|forest|meadow|recreation_ground)$"](${b});
  );out geom;`;
  const data = await overpass(q);
  const extract = { fetched: new Date().toISOString(), source: OVERPASS, center, bbox: bb, elements: data.elements };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${cfg.slug}.json`), JSON.stringify(extract));
  return extract;
}

// ---------- geometry ----------

function projector(bb) {
  // Web Mercator, scaled so the bbox fills the 2000 × 3000 poster.
  const mx = (lon) => (lon * Math.PI) / 180;
  const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const x0 = mx(bb.west);
  const x1 = mx(bb.east);
  const y0 = my(bb.south);
  const y1 = my(bb.north);
  const sx = W / (x1 - x0);
  const sy = H / (y1 - y0);
  const s = Math.max(sx, sy); // cover the poster, crop the rest
  const ox = (W - (x1 - x0) * s) / 2;
  const oy = (H - (y1 - y0) * s) / 2;
  return ({ lat, lon }) => [ox + (mx(lon) - x0) * s, H - (oy + (my(lat) - y0) * s)];
}

function pathFrom(points, proj, close) {
  if (!points || points.length < 2) return '';
  return points.map((p, i) => {
    const [x, y] = proj(p);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join('') + (close ? 'Z' : '');
}

// Area path for a way or a multipolygon relation (outer + inner rings, even-odd fill).
function areaPath(el, proj) {
  if (el.type === 'way') return pathFrom(el.geometry, proj, true);
  if (el.type === 'relation') {
    return (el.members || []).filter((m) => m.type === 'way' && m.geometry).map((m) => pathFrom(m.geometry, proj, true)).join('');
  }
  return '';
}

function centroid(el) {
  const pts = el.type === 'way' ? el.geometry : (el.members || []).flatMap((m) => m.geometry || []);
  const n = pts.length || 1;
  return { lat: pts.reduce((a, p) => a + p.lat, 0) / n, lon: pts.reduce((a, p) => a + p.lon, 0) / n };
}

function distM(a, b) {
  const dLat = (a.lat - b.lat) * 111320;
  const dLon = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// ---------- SVG ----------

function fontFaces() {
  const b64 = (f) => fs.readFileSync(path.join(FONT_DIR, f)).toString('base64');
  return `@font-face { font-family: 'Poster Text'; font-weight: 200 700; src: url(data:font/ttf;base64,${b64('Oswald-Variable.ttf')}) format('truetype'); }`;
}

function brandMark(color) {
  const file = path.join(__dirname, 'assets', 'brand', 'fraternity-mark.svg');
  const src = fs.readFileSync(file, 'utf8');
  const viewBox = src.match(/viewBox="([^"]+)"/)[1];
  const body = src.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return { viewBox, body, color };
}

function buildMapSvg(cfg, extract, { framed }) {
  const proj = projector(extract.bbox);
  const els = extract.elements;
  const center = extract.center;
  const out = [];
  const club = cfg.colors?.stadium || '#D2122E';

  const tag = (e, k) => (e.tags || {})[k];
  const greens = els.filter((e) => ['park', 'pitch'].includes(tag(e, 'leisure')) || ['grass', 'forest', 'meadow', 'recreation_ground'].includes(tag(e, 'landuse')));
  const water = els.filter((e) => tag(e, 'natural') === 'water');
  const rivers = els.filter((e) => e.type === 'way' && tag(e, 'waterway'));
  const buildings = els.filter((e) => tag(e, 'building'));
  const roads = els.filter((e) => e.type === 'way' && tag(e, 'highway') && STYLE.roads[tag(e, 'highway')]);
  const rails = els.filter((e) => e.type === 'way' && tag(e, 'railway'));

  // The featured stadium: the leisure=stadium area closest to the located centre.
  const stadia = els.filter((e) => tag(e, 'leisure') === 'stadium').sort((a, b) => distM(centroid(a), center) - distM(centroid(b), center));
  const stadium = stadia[0];
  // Pitches inside (≤ 120 m from) the stadium centre.
  const pitches = stadium ? els.filter((e) => tag(e, 'leisure') === 'pitch' && distM(centroid(e), centroid(stadium)) < 120) : [];

  const g = (cls, body) => `<g class="${cls}">${body}</g>`;
  out.push(`<rect x="${-BLEED}" y="${-BLEED}" width="${W + 2 * BLEED}" height="${H + 2 * BLEED}" fill="${STYLE.paper}"/>`);
  out.push(g('green', greens.map((e) => `<path d="${areaPath(e, proj)}" fill="${STYLE.green}" fill-rule="evenodd"/>`).join('')));
  out.push(g('water', water.map((e) => `<path d="${areaPath(e, proj)}" fill="${STYLE.water}" fill-rule="evenodd"/>`).join('')
    + rivers.map((e) => `<path d="${pathFrom(e.geometry, proj)}" fill="none" stroke="${STYLE.water}" stroke-width="10"/>`).join('')));
  out.push(g('buildings', buildings.map((e) => `<path d="${areaPath(e, proj)}" fill="${STYLE.building}" fill-rule="evenodd"/>`).join('')));
  out.push(g('rail', rails.map((e) => `<path d="${pathFrom(e.geometry, proj)}" fill="none" stroke="${STYLE.rail}" stroke-width="1.6" stroke-dasharray="7 5"/>`).join('')));
  // Roads: a black casing with a white core for the wide classes gives the double-line look.
  const sorted = roads.slice().sort((a, b) => STYLE.roads[tag(a, 'highway')] - STYLE.roads[tag(b, 'highway')]);
  out.push(g('roads', sorted.map((e) => {
    const w = STYLE.roads[tag(e, 'highway')];
    const d = pathFrom(e.geometry, proj);
    const tunnel = tag(e, 'tunnel') === 'yes' ? ' stroke-dasharray="10 6" opacity="0.5"' : '';
    if (w >= 4.5) return `<path d="${d}" fill="none" stroke="${STYLE.ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${tunnel}/><path d="${d}" fill="none" stroke="${STYLE.paper}" stroke-width="${(w * 0.45).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"${tunnel}/>`;
    return `<path d="${d}" fill="none" stroke="${STYLE.ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${tunnel}/>`;
  }).join('')));
  if (stadium) {
    out.push(g('stadium', `<path d="${areaPath(stadium, proj)}" fill="${club}" fill-rule="evenodd"/>`
      + pitches.map((e) => `<path d="${areaPath(e, proj)}" fill="#3C9A3A" stroke="#FFFFFF" stroke-width="2" fill-rule="evenodd"/>`).join('')));
  }

  // Title block on a white fade, like the reference.
  out.push(`<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.85"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>`);
  out.push(`<rect x="${-BLEED}" y="2380" width="${W + 2 * BLEED}" height="${H - 2380 + BLEED}" fill="url(#fade)"/>`);
  const t = (y, s, size, weight, ls, extra = '') => `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Poster Text" font-size="${size}" font-weight="${weight}" letter-spacing="${ls}" fill="${STYLE.ink}" ${extra}>${esc(String(s).toLocaleUpperCase('en'))}</text>`;
  out.push(t(2585, cfg.city, 58, 400, 12));
  out.push(t(2740, cfg.name, 170, 600, 4, 'data-maxw="1700"'));
  if (cfg.club) out.push(t(2830, cfg.club, 58, 400, 12));

  // Thin inner border (reference) – inside the dark frame on the framed variant.
  const inset = framed ? 70 : 60;
  out.push(`<rect x="${inset}" y="${inset}" width="${W - 2 * inset}" height="${H - 2 * inset}" fill="none" stroke="${STYLE.ink}" stroke-width="4"/>`);
  // Brand bottom right, attribution bottom left (required by the ODbL).
  const m = brandMark(STYLE.ink);
  out.push(`<text id="brand-text" x="${W - inset - 8}" y="${H - inset + 40}" text-anchor="end" font-family="Poster Text" font-size="26" font-weight="700" letter-spacing="1.5" fill="${STYLE.ink}">FRATERNITY</text>`);
  out.push(`<g id="brand-mark" data-h="21" data-w="${(21 * 100 / 86).toFixed(1)}" data-gap="8"><svg width="${(21 * 100 / 86).toFixed(1)}" height="21" viewBox="${m.viewBox}" fill="${m.color}">${m.body}</svg></g>`);
  out.push(`<text x="${inset + 8}" y="${H - inset + 40}" font-family="Poster Text" font-size="18" font-weight="400" fill="#777">© OpenStreetMap contributors</text>`);

  const frame = framed ? `<rect x="${-BLEED}" y="${-BLEED}" width="${W + 2 * BLEED}" height="${H + 2 * BLEED}" fill="none" stroke="#161616" stroke-width="${2 * (36 + BLEED)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-BLEED} ${-BLEED} ${W + 2 * BLEED} ${H + 2 * BLEED}" width="${W + 2 * BLEED}" height="${H + 2 * BLEED}">
<title>${esc(`${cfg.name} – ${cfg.city}`)}</title>
<defs><style>${fontFaces()}</style><clipPath id="paper"><rect x="${-BLEED}" y="${-BLEED}" width="${W + 2 * BLEED}" height="${H + 2 * BLEED}"/></clipPath></defs>
<g clip-path="url(#paper)">${out.join('\n')}${frame}</g>
</svg>`;
}

// ---------- export ----------

async function exportPoster(browser, svg, outDir) {
  const fullW = W + 2 * BLEED;
  const fullH = H + 2 * BLEED;
  fs.mkdirSync(outDir, { recursive: true });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${fullW / 100}in ${fullH / 100}in;margin:0}html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`;
  const trim = { x: BLEED, y: BLEED, width: W, height: H };
  const open = async (scale) => {
    const p = await browser.newPage({ viewport: { width: fullW, height: fullH }, deviceScaleFactor: scale });
    await p.setContent(html);
    await p.evaluate(async () => {
      await document.fonts.ready;
      const svgEl = document.querySelector('svg');
      for (const t of svgEl.querySelectorAll('text[data-maxw]')) {
        const max = parseFloat(t.dataset.maxw);
        const w = t.getBBox().width;
        if (w > max) t.setAttribute('font-size', (parseFloat(t.getAttribute('font-size')) * max / w).toFixed(1));
      }
      const tx = svgEl.querySelector('#brand-text');
      const mk = svgEl.querySelector('#brand-mark');
      const b = tx.getBBox();
      mk.setAttribute('transform', `translate(${b.x - +mk.dataset.gap - +mk.dataset.w} ${+tx.getAttribute('y') - +mk.dataset.h})`);
    });
    return p;
  };
  const page = await open(1);
  fs.writeFileSync(path.join(outDir, 'poster.svg'), await page.evaluate(() => document.querySelector('svg').outerHTML));
  await page.pdf({ path: path.join(outDir, 'print.pdf'), width: `${fullW / 100}in`, height: `${fullH / 100}in`, printBackground: true });
  await page.close();
  const prev = await open(0.6);
  await prev.screenshot({ path: path.join(outDir, 'preview.jpg'), type: 'jpeg', quality: 88, clip: trim });
  await prev.close();
  const posterH = Math.round(2048 * 0.9);
  const shot = await open(posterH / H);
  const png = await shot.screenshot({ type: 'png', clip: trim });
  await shot.close();
  const shop = await browser.newPage({ viewport: { width: 2048, height: 2048 } });
  await shop.setContent(`<body style="margin:0;width:2048px;height:2048px;background:#fff;display:flex;align-items:center;justify-content:center"><img src="data:image/png;base64,${png.toString('base64')}" style="width:${Math.round(posterH * W / H)}px;height:${posterH}px;box-shadow:0 24px 48px rgba(0,0,0,.22),0 6px 14px rgba(0,0,0,.14)"></body>`);
  await shop.screenshot({ path: path.join(outDir, 'shop-2048.jpg'), type: 'jpeg', quality: 92 });
  await shop.close();
  const big = await open(PRINT_SCALE);
  await big.screenshot({ path: path.join(outDir, 'print.png'), type: 'png' });
  await big.close();
}

async function renderOne(browser, file, fetchFirst) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cache = path.join(CACHE_DIR, `${cfg.slug}.json`);
  let extract;
  if (fetchFirst || !fs.existsSync(cache)) {
    console.log(`fetch ${cfg.name} from ${OVERPASS}`);
    extract = await fetchExtract(cfg);
  } else {
    extract = JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  if (!extract.elements.some((e) => (e.tags || {}).leisure === 'stadium')) {
    throw new Error(`${cfg.slug}: no leisure=stadium area in the extract – the stadium would not be highlighted`);
  }
  for (const framed of [true, false]) {
    const dir = path.join(ROOT, 'output', `stadium-${cfg.slug}-${framed ? 'framed' : 'frameless'}`);
    await exportPoster(browser, buildMapSvg(cfg, extract, { framed }), dir);
    console.log(`done  ${path.relative(ROOT, dir)}/`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fetchFirst = args.includes('--fetch');
  const files = args.includes('--all')
    ? fs.readdirSync(path.join(ROOT, 'stadiums')).filter((f) => f.endsWith('.json')).map((f) => path.join(ROOT, 'stadiums', f))
    : args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: node poster/stadium-map.js stadiums/<slug>.json [--fetch] | --all [--fetch]');
    process.exit(2);
  }
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const f of files) {
      try {
        await renderOne(browser, f, fetchFirst);
      } catch (e) {
        failed++;
        console.error(`ERROR ${path.basename(f)}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { buildMapSvg, bboxAround };
