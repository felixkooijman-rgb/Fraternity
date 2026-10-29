#!/usr/bin/env node
'use strict';
// Usage: node poster/render.js matches/<slug>.json [--force] [--no-print] [--out output]
//
// Produces in output/<slug>/:
//   poster.svg       editable master (live text, embedded fonts, fitted)
//   preview.jpg      1200×1800 web preview (trim area)
//   shop-2048.jpg    2048×2048 square shop image (poster centred on white with a soft shadow)
//   print.pdf        vector print file incl. bleed (fonts embedded by Chromium)
//   print.png        6000×9000 trim (+bleed) raster at 300 dpi for 50.8×76.2 cm
//   match.json       the verified match data used
//   sources.md       sources + items flagged for manual confirmation
//   qa-report.json   data checks + layout checks (overlaps, safe area, fitting)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { validate } = require('./lib/validate');
const { buildSvg } = require('./lib/build-svg');

const ROOT = path.join(__dirname, '..');
const PRINT_SCALE = 3; // 2000 units × 3 = 6000 px trim width

function parseArgs(argv) {
  const args = { force: false, print: true, out: path.join(ROOT, 'output') };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--no-print') args.print = false;
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else rest.push(argv[i]);
  }
  args.input = rest[0];
  return args;
}

function sourcesMd(data, qa) {
  const v = data.verification || {};
  const lines = [`# Sources – ${data.match.home.name} ${data.match.score.home}-${data.match.score.away} ${data.match.away.name} (${data.match.date})`, ''];
  lines.push('## Sources', '');
  for (const s of v.sources || []) lines.push(`- [${s.title}](${s.url}) — ${s.used_for}`);
  lines.push('', '## Confirmed', '');
  for (const c of v.confirmed || []) lines.push(`- ${c}`);
  lines.push('', '## Needs manual confirmation', '');
  for (const c of v.needs_manual_check || []) lines.push(`- [ ] ${c}`);
  if (qa.layout.errors.length) {
    lines.push('', '## Layout QA errors', '');
    for (const e of qa.layout.errors) lines.push(`- ${e}`);
  }
  return lines.join('\n') + '\n';
}

// Runs inside the page: shrink text that is too wide, then check overlaps and safe area.
function fitAndCheck() {
  const svg = document.querySelector('svg');
  const fitted = [];
  for (const t of svg.querySelectorAll('text[data-maxw]')) {
    const max = parseFloat(t.dataset.maxw);
    const w = t.getBBox().width;
    if (w > max) {
      const s = parseFloat(t.getAttribute('font-size'));
      const ns = Math.floor(s * (max / w) * 100) / 100;
      t.setAttribute('font-size', ns);
      if (t.hasAttribute('letter-spacing')) t.setAttribute('letter-spacing', (parseFloat(t.getAttribute('letter-spacing')) * ns / s).toFixed(2));
      // Layered hero text (line + gap copies) shrinks together with its main layer.
      if (t.parentNode.dataset && t.parentNode.dataset.sync) {
        for (const sib of t.parentNode.querySelectorAll('text')) {
          if (sib === t) continue;
          sib.setAttribute('font-size', ns);
          if (t.hasAttribute('letter-spacing')) sib.setAttribute('letter-spacing', t.getAttribute('letter-spacing'));
        }
      }
      fitted.push(`"${t.textContent}" ${s}→${ns}`);
    }
  }
  // Place the brand mark just left of the (measured) wordmark.
  const brandText = svg.querySelector('#brand-text');
  const brandMark = svg.querySelector('#brand-mark');
  if (brandText && brandMark) {
    const h = parseFloat(brandMark.dataset.h);
    const w = parseFloat(brandMark.dataset.w);
    const gap = parseFloat(brandMark.dataset.gap);
    if (brandText.dataset.cx) {
      // Centre mark + wordmark as one unit on the given x.
      const total = w + gap + brandText.getBBox().width;
      brandText.setAttribute('x', (parseFloat(brandText.dataset.cx) + total / 2).toFixed(2));
      brandText.removeAttribute('data-cx');
    }
    const tb = brandText.getBBox();
    const baseline = parseFloat(brandText.getAttribute('y'));
    brandMark.setAttribute('transform', `translate(${(tb.x - gap - w).toFixed(2)} ${(baseline - h).toFixed(2)})`);
  }
  const [sx, sy, sw, sh] = svg.dataset.safe.split(' ').map(Number);
  const boxes = [...svg.querySelectorAll('text[data-qa]')].map((t) => ({ t: t.textContent, b: t.getBBox() }));
  const errors = [];
  // Glyph boxes include ascender/descender space; shrink vertically to the caps so
  // stacked lines and big numerals near the edge don't false-positive.
  const tight = (b) => ({ x: b.x, y: b.y + b.height * 0.22, w: b.width, h: b.height * 0.6 });
  for (const { t, b } of boxes) {
    const k = tight(b);
    if (k.x < sx || k.y < sy || k.x + k.w > sx + sw || k.y + k.h > sy + sh) errors.push(`"${t}" leaves the safe area`);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = tight(boxes[i].b);
      const b = tight(boxes[j].b);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        errors.push(`"${boxes[i].t}" overlaps "${boxes[j].t}"`);
      }
    }
  }
  for (const t of svg.querySelectorAll('[data-maxw],[data-qa],[data-sync]')) {
    t.removeAttribute('data-maxw');
    t.removeAttribute('data-qa');
    t.removeAttribute('data-sync');
  }
  return { fitted, errors, svg: svg.outerHTML };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('usage: node poster/render.js matches/<slug>.json [--force] [--no-print] [--out dir]');
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const theme = typeof base.theme === 'string'
    ? JSON.parse(fs.readFileSync(path.join(__dirname, 'themes', `${base.theme}.json`), 'utf8'))
    : base.theme;

  // "variants" renders several versions of one match (e.g. with / without line-ups)
  // into output/<slug>-<variant>/, each with its own display settings.
  const variants = base.variants ? Object.entries(base.variants) : [[null, {}]];
  let failed = false;
  for (const [name, v] of variants) {
    const data = {
      ...base,
      slug: name ? `${base.slug}-${name}` : base.slug,
      display: { ...base.display, ...(v.display || {}) },
    };
    delete data.variants;
    if (name) console.log(`\n== variant ${name}`);
    if (!(await renderOne(args, data, theme))) failed = true;
  }
  if (failed) process.exitCode = 1;
}

async function renderOne(args, data, theme) {
  const check = validate(data);
  check.warnings.forEach((w) => console.warn(`warn  ${w}`));
  check.errors.forEach((e) => console.error(`ERROR ${e}`));
  if (check.errors.length && !args.force) {
    console.error('Data validation failed – fix the match file (or use --force for a draft).');
    return false;
  }

  const { svg, W, H, bleed } = buildSvg(data, theme);
  const fullW = W + 2 * bleed;
  const fullH = H + 2 * bleed;

  const outDir = path.join(args.out, data.slug);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${fullW / 100}in ${fullH / 100}in; margin: 0 }
      html, body { margin: 0; padding: 0; background: #fff }
      svg { display: block; width: ${fullW}px; height: ${fullH}px }
    </style></head><body>${svg}</body></html>`;

    const page = await browser.newPage({ viewport: { width: fullW, height: fullH } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    // Load every embedded face explicitly (unused faces would otherwise stay 'unloaded').
    const fontsOk = await page.evaluate(async () => {
      const faces = [...document.fonts];
      await Promise.all(faces.map((f) => f.load().catch(() => null)));
      return faces.length > 0 && faces.every((f) => f.status === 'loaded');
    });
    const layout = await page.evaluate(fitAndCheck);
    if (!fontsOk) layout.errors.push('embedded fonts failed to load');
    fs.writeFileSync(path.join(outDir, 'poster.svg'), layout.svg);

    const finalHtml = html.replace(svg, layout.svg);
    const trimClip = { x: bleed, y: bleed, width: W, height: H };

    const preview = await browser.newPage({ viewport: { width: fullW, height: fullH }, deviceScaleFactor: 0.6 });
    await preview.setContent(finalHtml);
    await preview.evaluate(() => document.fonts.ready);
    await preview.screenshot({ path: path.join(outDir, 'preview.jpg'), type: 'jpeg', quality: 88, clip: trimClip });
    await preview.close();

    // Square shop image: the trimmed poster at 90 % of the canvas height, centred.
    const SHOP = 2048;
    const posterH = Math.round(SHOP * 0.9);
    const posterW = Math.round(posterH * W / H);
    const shot = await browser.newPage({ viewport: { width: fullW, height: fullH }, deviceScaleFactor: posterH / H });
    await shot.setContent(finalHtml);
    await shot.evaluate(() => document.fonts.ready);
    const png = await shot.screenshot({ type: 'png', clip: trimClip });
    await shot.close();
    const shop = await browser.newPage({ viewport: { width: SHOP, height: SHOP } });
    await shop.setContent(`<!doctype html><html><body style="margin:0;width:${SHOP}px;height:${SHOP}px;background:#fff;display:flex;align-items:center;justify-content:center">
      <img src="data:image/png;base64,${png.toString('base64')}" style="width:${posterW}px;height:${posterH}px;box-shadow:0 24px 48px rgba(0,0,0,.22),0 6px 14px rgba(0,0,0,.14)">
      </body></html>`);
    await shop.screenshot({ path: path.join(outDir, 'shop-2048.jpg'), type: 'jpeg', quality: 92 });
    await shop.close();

    if (args.print) {
      await page.setContent(finalHtml);
      await page.evaluate(() => document.fonts.ready);
      await page.pdf({ path: path.join(outDir, 'print.pdf'), width: `${fullW / 100}in`, height: `${fullH / 100}in`, printBackground: true, preferCSSPageSize: true });

      const big = await browser.newPage({ viewport: { width: fullW, height: fullH }, deviceScaleFactor: PRINT_SCALE });
      await big.setContent(finalHtml);
      await big.evaluate(() => document.fonts.ready);
      await big.screenshot({ path: path.join(outDir, 'print.png'), type: 'png', fullPage: false });
      await big.close();
    }

    const qa = {
      generated: new Date().toISOString(),
      data: check,
      layout: { fitted: layout.fitted, errors: layout.errors },
      output: {
        trim_px: [W * PRINT_SCALE, H * PRINT_SCALE],
        bleed_px: bleed * PRINT_SCALE,
        print_png_px: args.print ? [fullW * PRINT_SCALE, fullH * PRINT_SCALE] : null,
        dpi_at: `${(W * PRINT_SCALE / 300 * 2.54).toFixed(1)} × ${(H * PRINT_SCALE / 300 * 2.54).toFixed(1)} cm trim @ 300 dpi`,
      },
    };
    fs.writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(qa, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'match.json'), JSON.stringify(data, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'sources.md'), sourcesMd(data, qa));

    layout.fitted.forEach((f) => console.log(`fit   ${f}`));
    layout.errors.forEach((e) => console.error(`LAYOUT ${e}`));
    console.log(`done  ${path.relative(ROOT, outDir)}/ (${fs.readdirSync(outDir).join(', ')})`);
    return layout.errors.length === 0;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
