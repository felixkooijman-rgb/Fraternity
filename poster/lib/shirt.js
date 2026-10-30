'use strict';
// Draws the front of the match shirt behind the poster content.
//
// theme.shirt = {
//   base: '#hex',                         // shirt body colour
//   layers: [ … ],                        // drawn in order over the base (see below)
//   panel: { color, x0, x1, y0, y1 },     // plain field for the text (defaults below)
//   collar: { type: 'v' | 'crew' | 'polo', color, width },
// }
// Layer types (all coordinates are fractions of the art area):
//   { type: 'stripes', color, count, ratio = 0.5, phase = 0 }   vertical stripes
//   { type: 'hoops', color, count, ratio = 0.5, phase = 0 }     horizontal bands
//   { type: 'halves', color, side: 'left' | 'right' }           half-and-half
//   { type: 'rect', color, x0, x1, y0, y1 }                     blocks: bands, yokes, shoulders
//   { type: 'pattern', kind, color, opacity = 1, scale = 1 }    chevron | diamond | diagonal | leaf | crest
//   { type: 'gradient', from, to }                              vertical colour fade
// Edges are clean seams by default; `torn: true` gives the ripped-paper edges of the PSV reference.

function tornLine(rand, from, to, axis, jitter = 9) {
  // axis 'v': vertical line at x=from[0] from y=from[1] to y=to[1]; 'h': horizontal.
  const pts = [];
  const [a0, a1] = axis === 'v' ? [from[1], to[1]] : [from[0], to[0]];
  const fixed = axis === 'v' ? from[0] : from[1];
  const dir = a1 > a0 ? 1 : -1;
  let a = a0;
  while ((a1 - a) * dir > 0) {
    const big = rand() < 0.08;
    const d = (rand() - 0.5) * (big ? jitter * 2.4 : jitter);
    pts.push(axis === 'v' ? [fixed + d, a] : [a, fixed + d]);
    a += dir * (14 + rand() * 46);
  }
  pts.push(axis === 'v' ? [fixed, a1] : [a1, fixed]);
  return pts;
}

function poly(pts) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ' Z';
}

// Rectangle with torn edges (any side can be kept straight when it runs off the art).
// jitter 0 gives clean seams (default, like the shirt-front reference); >0 gives torn edges.
let JITTER = 0;

function tornRect(rand, x0, y0, x1, y1) {
  if (!JITTER) return poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  return poly([
    ...tornLine(rand, [x0, y0], [x1, y0], 'h', JITTER),
    ...tornLine(rand, [x1, y0], [x1, y1], 'v', JITTER),
    ...tornLine(rand, [x1, y1], [x0, y1], 'h', JITTER),
    ...tornLine(rand, [x0, y1], [x0, y0], 'v', JITTER),
  ]);
}

const PATTERNS = {
  // Interlocking chevrons / upward arrows (adidas 1988, Nike 2014 isometric grid).
  chevron: (s, color) => ({ w: 80 * s, h: 60 * s, body: `<path d="M0 ${45 * s} L${40 * s} ${15 * s} L${80 * s} ${45 * s} L${80 * s} ${60 * s} L${40 * s} ${30 * s} L0 ${60 * s} Z" fill="${color}"/>` }),
  diamond: (s, color) => ({ w: 60 * s, h: 60 * s, body: `<path d="M${30 * s} 0 L${60 * s} ${30 * s} L${30 * s} ${60 * s} L0 ${30 * s} Z" fill="${color}"/>` }),
  diagonal: (s, color) => ({ w: 70 * s, h: 70 * s, body: `<path d="M0 ${70 * s} L${70 * s} 0 L${70 * s} ${22 * s} L${22 * s} ${70 * s} Z" fill="${color}"/>` }),
  // Stylised leaf/feather outline (Go Ahead Eagles purple cup-final shirt).
  leaf: (s, color) => ({ w: 64 * s, h: 96 * s, body: `<path d="M${32 * s} ${4 * s} C${58 * s} ${30 * s} ${58 * s} ${66 * s} ${32 * s} ${92 * s} C${6 * s} ${66 * s} ${6 * s} ${30 * s} ${32 * s} ${4 * s} Z M${32 * s} ${12 * s} L${32 * s} ${88 * s}" fill="none" stroke="${color}" stroke-width="${2.2 * s}"/>` }),
  // Flowing swirls (Nike Netherlands 2022: "dancing swirl" inspired by a lion's mane).
  swirl: (s, color) => ({ w: 140 * s, h: 90 * s, body: `<path d="M0 ${45 * s} C${35 * s} ${5 * s} ${70 * s} ${85 * s} ${105 * s} ${45 * s} S${140 * s} ${25 * s} ${140 * s} ${45 * s} M0 ${75 * s} C${35 * s} ${35 * s} ${70 * s} ${115 * s} ${105 * s} ${75 * s}" fill="none" stroke="${color}" stroke-width="${9 * s}" stroke-linecap="round"/>` }),
  // Repeating abstract roundel (Ajax 1994-95 away: twisted crest motifs; not the actual crest).
  crest: (s, color) => ({ w: 120 * s, h: 120 * s, body: `<g fill="none" stroke="${color}" stroke-width="${5 * s}"><circle cx="${40 * s}" cy="${40 * s}" r="${22 * s}"/><path d="M${24 * s} ${40 * s} C${34 * s} ${26 * s} ${46 * s} ${54 * s} ${56 * s} ${40 * s}"/><circle cx="${100 * s}" cy="${100 * s}" r="${22 * s}"/><path d="M${84 * s} ${100 * s} C${94 * s} ${86 * s} ${106 * s} ${114 * s} ${116 * s} ${100 * s}"/></g>` }),
};

function drawShirt(spec, { rand, art, paint, ax, ay, defs }) {
  const out = [];
  JITTER = spec.torn ? 9 : 0;
  const X0 = paint.x - 30;
  const X1 = paint.x + paint.w + 30;
  const Y0 = paint.y - 30;
  const Y1 = paint.y + paint.h + 30;
  out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="${spec.base}"/>`);
  let gradientId = null;

  (spec.layers || []).forEach((l, n) => {
    if (l.type === 'gradient') {
      gradientId = `shirtGrad${n}`;
      defs.push(`<linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${l.from}"/><stop offset="1" stop-color="${l.to}"/></linearGradient>`);
      out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="url(#${gradientId})"/>`);
    } else if (l.type === 'stripes') {
      const period = art.w / l.count;
      const w = period * (l.ratio ?? 0.5);
      for (let i = -1; i <= l.count; i++) {
        const x = art.x + (i + (l.phase ?? 0)) * period;
        if (x + w < X0 || x > X1) continue;
        out.push(`<path d="${tornRect(rand, x, Y0, x + w, Y1)}" fill="${l.color}"/>`);
      }
    } else if (l.type === 'hoops') {
      const period = art.h / l.count;
      const h = period * (l.ratio ?? 0.5);
      for (let i = -1; i <= l.count; i++) {
        const y = art.y + (i + (l.phase ?? 0)) * period;
        if (y + h < Y0 || y > Y1) continue;
        out.push(`<path d="${tornRect(rand, X0, y, X1, y + h)}" fill="${l.color}"/>`);
      }
    } else if (l.type === 'halves') {
      const mid = ax(0.5);
      out.push(`<path d="${l.side === 'left' ? tornRect(rand, X0, Y0, mid, Y1) : tornRect(rand, mid, Y0, X1, Y1)}" fill="${l.color}"/>`);
    } else if (l.type === 'rect') {
      const x0 = l.x0 <= 0 ? X0 : ax(l.x0);
      const x1 = l.x1 >= 1 ? X1 : ax(l.x1);
      const y0 = l.y0 <= 0 ? Y0 : ay(l.y0);
      const y1 = l.y1 >= 1 ? Y1 : ay(l.y1);
      out.push(`<path d="${tornRect(rand, x0, y0, x1, y1)}" fill="${l.color}"/>`);
    } else if (l.type === 'pattern') {
      const make = PATTERNS[l.kind];
      if (!make) throw new Error(`unknown shirt pattern "${l.kind}"`);
      const p = make(l.scale ?? 1, l.color);
      const id = `shirtPat${n}`;
      defs.push(`<pattern id="${id}" width="${p.w}" height="${p.h}" patternUnits="userSpaceOnUse">${p.body}</pattern>`);
      out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="url(#${id})" opacity="${l.opacity ?? 1}"/>`);
    } else {
      throw new Error(`unknown shirt layer "${l.type}"`);
    }
  });

  // Plain field for the typography (like the number panel on the reference poster).
  // Only when the theme asks for it: by default the shirt runs behind all text (brand style).
  const pn = { x0: 0.146, x1: 0.854, y0: 0.045, y1: 0.815, ...(spec.panel || {}) };
  if (spec.panel && pn.color !== 'none') {
    const fill = pn.color || (gradientId ? `url(#${gradientId})` : spec.base);
    out.push(`<path d="${tornRect(rand, ax(pn.x0), ay(pn.y0), ax(pn.x1), ay(pn.y1))}" fill="${fill}"/>`);
  }

  // Collar at the top centre.
  const col = spec.collar;
  if (col) {
    const cx = ax(0.5);
    const w = (col.width ?? 0.09) * art.w;
    const t = 22;
    const yTop = paint.y - 10;
    if (col.type === 'v') {
      const depth = ay(0.042);
      out.push(`<path d="M${cx - w} ${yTop} L${cx} ${depth} L${cx + w} ${yTop} L${cx + w - t * 1.4} ${yTop} L${cx} ${depth - t * 1.6} L${cx - w + t * 1.4} ${yTop} Z" fill="${col.color}"/>`);
    } else {
      const depth = ay(col.type === 'polo' ? 0.035 : 0.045);
      out.push(`<path d="M${cx - w} ${yTop} Q${cx} ${depth * 2 - yTop} ${cx + w} ${yTop} L${cx + w - t} ${yTop} Q${cx} ${depth * 2 - yTop - t * 2} ${cx - w + t} ${yTop} Z" fill="${col.color}"/>`);
      if (col.type === 'polo') {
        out.push(`<rect x="${cx - 9}" y="${depth - 4}" width="18" height="${ay(0.075) - depth}" fill="${col.color}"/>`);
      }
    }
  }
  return out.join('\n');
}

module.exports = { drawShirt };
